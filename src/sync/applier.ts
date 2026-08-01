import type {
  AgentAdapter,
  ApplyResult,
  ContextInstructionChange,
  ContextInstructionOwnership,
  OwnershipEntry,
  PreparedManifest,
  ReceiptAction,
  SyncChange,
} from "../domain.js";
import { HivemndError } from "../errors.js";
import { sha256 } from "./hash.js";
import type {
  AlwaysContextCache,
  AlwaysContextCacheChange,
  AlwaysContextCacheSnapshot,
} from "../context/always-context-cache.js";

export interface AlwaysContextCacheApplication {
  readonly cache: AlwaysContextCache;
  readonly change: AlwaysContextCacheChange;
}

interface AdapterSnapshot {
  readonly adapter: AgentAdapter;
  readonly ownership: readonly OwnershipEntry[];
  readonly files: Map<string, Uint8Array | undefined>;
  readonly contextInstructionOwnership?:
    ContextInstructionOwnership | undefined;
  readonly instructionCaptured: boolean;
  readonly instruction?: Uint8Array;
}

export class SyncApplier {
  async apply(
    manifest: PreparedManifest,
    changes: readonly SyncChange[],
    adapters: readonly AgentAdapter[],
    contextChanges: readonly ContextInstructionChange[] = [],
    cacheApplication?: AlwaysContextCacheApplication,
  ): Promise<ApplyResult> {
    const conflicts = [
      ...changes.filter((change) => change.kind === "conflict"),
      ...contextChanges.filter((change) => change.kind === "conflict"),
    ];
    if (conflicts.length > 0) {
      throw new HivemndError(
        "SYNC_CONFLICT",
        `Cannot apply synchronization with ${conflicts.length} conflict(s)`,
      );
    }
    validateAssignments(changes);
    validateContextAssignments(contextChanges);
    for (const change of changes) {
      if (change.kind === "remove") requireOwned(change);
      else requireArtifact(change);
    }
    const adaptersByName = new Map(
      adapters.map((adapter) => [adapter.name, adapter]),
    );
    for (const change of changes)
      requireAdapter(adaptersByName, change.destinationName);
    for (const change of contextChanges)
      requireInstructionAdapter(adaptersByName, change.destinationName);

    const contextByDestination = new Map(
      contextChanges.map((change) => [change.destinationName, change]),
    );

    const cacheSnapshot: AlwaysContextCacheSnapshot | undefined =
      await cacheApplication?.cache.snapshot();
    const snapshots = await Promise.all(
      adapters.map(async (adapter): Promise<AdapterSnapshot> => {
        const adapterChanges = changes.filter(
          (change) =>
            change.destinationName === adapter.name &&
            change.kind !== "unchanged" &&
            change.kind !== "adopt",
        );
        const contextChange = contextByDestination.get(adapter.name);
        const instructionAdapter = contextChange
          ? requireInstructionAdapter(adaptersByName, adapter.name)
          : undefined;
        const instruction = instructionAdapter
          ? await instructionAdapter.readInstruction()
          : undefined;
        if (
          contextChange &&
          (instruction ? sha256(instruction) : null) !==
            contextChange.expectedFileSha256
        ) {
          throw new HivemndError(
            "SYNC_CONFLICT",
            `Host instruction file changed while synchronization was being prepared: ${contextChange.destination}`,
          );
        }
        return {
          adapter,
          ownership: await adapter.readOwnership(),
          contextInstructionOwnership:
            await adapter.readContextInstructionOwnership?.(),
          instructionCaptured: instructionAdapter !== undefined,
          ...(instruction ? { instruction } : {}),
          files: new Map(
            await Promise.all(
              adapterChanges.map(
                async (change) =>
                  [
                    change.relativePath,
                    await adapter.read(change.relativePath),
                  ] as const,
              ),
            ),
          ),
        };
      }),
    );

    try {
      for (const change of changes) {
        const adapter = requireAdapter(adaptersByName, change.destinationName);
        if (change.kind === "create" || change.kind === "update") {
          await adapter.write(
            change.relativePath,
            requireArtifact(change).content,
          );
        } else if (change.kind === "remove") {
          await adapter.remove(change.relativePath);
        }
      }
      for (const change of contextChanges) {
        if (change.kind === "unchanged") continue;
        const adapter = requireInstructionAdapter(
          adaptersByName,
          change.destinationName,
        );
        if (change.kind === "remove" && !change.content) {
          await adapter.removeInstruction();
        } else {
          await adapter.writeInstruction(requireContextContent(change));
        }
      }
      for (const snapshot of snapshots) {
        const next = new Map(
          snapshot.ownership.map((entry) => [entry.relativePath, entry]),
        );
        for (const change of changes.filter(
          (candidate) => candidate.destinationName === snapshot.adapter.name,
        )) {
          if (change.kind === "remove") {
            next.delete(change.relativePath);
          } else {
            const artifact = requireArtifact(change);
            next.set(change.relativePath, {
              relativePath: change.relativePath,
              logicalId: artifact.logicalId,
              artifactVersionId: artifact.artifactVersionId,
              sha256: artifact.sha256,
              releaseId: manifest.release.id,
            });
          }
        }
        const contextChange = contextByDestination.get(snapshot.adapter.name);
        await snapshot.adapter.replaceOwnership(
          [...next.values()],
          contextChange ? contextChange.ownership : undefined,
        );
      }
      if (cacheApplication) {
        await cacheApplication.cache.apply(cacheApplication.change);
      }
    } catch (error: unknown) {
      await rollback(snapshots);
      if (cacheApplication && cacheSnapshot) {
        await cacheApplication.cache.restore(cacheSnapshot);
      }
      throw new HivemndError(
        "SYNC_FAILED",
        "Synchronization failed and local changes were rolled back",
        { cause: error },
      );
    }

    return {
      applied:
        changes.filter((change) =>
          ["adopt", "create", "update", "remove"].includes(change.kind),
        ).length +
        (cacheApplication && cacheApplication.change.kind !== "unchanged"
          ? 1
          : 0),
      operations: [
        ...changes.map((change) => ({
          artifactVersionId:
            change.kind === "remove"
              ? requireOwned(change).artifactVersionId
              : requireArtifact(change).artifactVersionId,
          target: change.agent,
          action: (change.kind === "adopt"
            ? "unchanged"
            : change.kind) as ReceiptAction,
          result:
            change.kind === "unchanged" || change.kind === "adopt"
              ? ("skipped" as const)
              : ("applied" as const),
        })),
        ...(cacheApplication?.change.manifest?.entries.flatMap((entry) =>
          [
            ...new Set(
              entry.deliveryTargets.map((target) => target.clientKind),
            ),
          ].map((target) => ({
            artifactVersionId: entry.artifactVersionId,
            target,
            action: "unchanged" as const,
            result:
              cacheApplication.change.kind === "unchanged"
                ? ("skipped" as const)
                : ("applied" as const),
          })),
        ) ?? []),
      ],
    };
  }
}

async function rollback(snapshots: readonly AdapterSnapshot[]): Promise<void> {
  for (const snapshot of [...snapshots].reverse()) {
    for (const [relativePath, content] of [...snapshot.files].reverse()) {
      if (content === undefined) await snapshot.adapter.remove(relativePath);
      else await snapshot.adapter.write(relativePath, content);
    }
    if (snapshot.instructionCaptured) {
      const adapter = requireInstructionAdapter(
        new Map([[snapshot.adapter.name, snapshot.adapter]]),
        snapshot.adapter.name,
      );
      if (snapshot.instruction) {
        await adapter.writeInstruction(snapshot.instruction);
      } else {
        await adapter.removeInstruction();
      }
    }
    await snapshot.adapter.replaceOwnership(
      snapshot.ownership,
      snapshot.contextInstructionOwnership ?? null,
    );
  }
}

function validateContextAssignments(
  changes: readonly ContextInstructionChange[],
): void {
  const assignments = new Set<string>();
  for (const change of changes) {
    if (assignments.has(change.destinationName)) {
      throw new HivemndError(
        "SYNC_FAILED",
        `Cannot apply duplicate context instruction assignment: ${change.destinationName}`,
      );
    }
    assignments.add(change.destinationName);
  }
}

function requireInstructionAdapter(
  adapters: ReadonlyMap<string, AgentAdapter>,
  name: string,
): AgentAdapter & {
  readInstruction(): Promise<Uint8Array | undefined>;
  writeInstruction(content: Uint8Array): Promise<void>;
  removeInstruction(): Promise<void>;
} {
  const adapter = requireAdapter(adapters, name);
  if (
    !adapter.readInstruction ||
    !adapter.writeInstruction ||
    !adapter.removeInstruction
  ) {
    throw new HivemndError(
      "SYNC_FAILED",
      `Destination does not support always-on instructions: ${name}`,
    );
  }
  return adapter as AgentAdapter & {
    readInstruction(): Promise<Uint8Array | undefined>;
    writeInstruction(content: Uint8Array): Promise<void>;
    removeInstruction(): Promise<void>;
  };
}

function requireContextContent(change: ContextInstructionChange): Uint8Array {
  if (!change.content) {
    throw new HivemndError(
      "SYNC_FAILED",
      `Missing host instruction content for ${change.kind} operation`,
    );
  }
  return change.content;
}

function validateAssignments(changes: readonly SyncChange[]): void {
  const assignments = new Set<string>();
  for (const change of changes) {
    const assignment = `${change.destinationName}:${change.relativePath}`;
    if (assignments.has(assignment)) {
      throw new HivemndError(
        "SYNC_FAILED",
        `Cannot apply duplicate artifact assignment: ${assignment}`,
      );
    }
    assignments.add(assignment);
  }
}

function requireAdapter(
  adapters: ReadonlyMap<string, AgentAdapter>,
  name: string,
): AgentAdapter {
  const adapter = adapters.get(name);
  if (!adapter) {
    throw new HivemndError("SYNC_FAILED", `Missing adapter for ${name}`);
  }
  return adapter;
}

function requireArtifact(change: SyncChange) {
  if (!change.artifact) {
    throw new HivemndError(
      "SYNC_FAILED",
      `Missing artifact for ${change.kind} operation`,
    );
  }
  return change.artifact;
}

function requireOwned(change: SyncChange): OwnershipEntry {
  if (!change.owned) {
    throw new HivemndError(
      "SYNC_FAILED",
      `Missing ownership for ${change.kind} operation`,
    );
  }
  return change.owned;
}
