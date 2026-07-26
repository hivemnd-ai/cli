import type {
  AgentAdapter,
  ApplyResult,
  OwnershipEntry,
  PreparedManifest,
  ReceiptAction,
  SyncChange,
} from "../domain.js";
import { HivemndError } from "../errors.js";

interface AdapterSnapshot {
  readonly adapter: AgentAdapter;
  readonly ownership: readonly OwnershipEntry[];
  readonly files: Map<string, Uint8Array | undefined>;
}

export class SyncApplier {
  async apply(
    manifest: PreparedManifest,
    changes: readonly SyncChange[],
    adapters: readonly AgentAdapter[],
  ): Promise<ApplyResult> {
    const conflicts = changes.filter((change) => change.kind === "conflict");
    if (conflicts.length > 0) {
      throw new HivemndError(
        "SYNC_CONFLICT",
        `Cannot apply synchronization with ${conflicts.length} conflict(s)`,
      );
    }
    validateAssignments(changes);
    for (const change of changes) {
      if (change.kind === "remove") requireOwned(change);
      else requireArtifact(change);
    }
    const adaptersByName = new Map(
      adapters.map((adapter) => [adapter.name, adapter]),
    );
    for (const change of changes)
      requireAdapter(adaptersByName, change.destinationName);

    const snapshots = await Promise.all(
      adapters.map(async (adapter): Promise<AdapterSnapshot> => {
        const adapterChanges = changes.filter(
          (change) =>
            change.destinationName === adapter.name &&
            change.kind !== "unchanged" &&
            change.kind !== "adopt",
        );
        return {
          adapter,
          ownership: await adapter.readOwnership(),
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
        await snapshot.adapter.replaceOwnership([...next.values()]);
      }
    } catch (error: unknown) {
      await rollback(snapshots);
      throw new HivemndError(
        "SYNC_FAILED",
        "Synchronization failed and local changes were rolled back",
        { cause: error },
      );
    }

    return {
      applied: changes.filter((change) =>
        ["adopt", "create", "update", "remove"].includes(change.kind),
      ).length,
      operations: changes.map((change) => ({
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
            ? "skipped"
            : "applied",
      })),
    };
  }
}

async function rollback(snapshots: readonly AdapterSnapshot[]): Promise<void> {
  for (const snapshot of [...snapshots].reverse()) {
    for (const [relativePath, content] of [...snapshot.files].reverse()) {
      if (content === undefined) await snapshot.adapter.remove(relativePath);
      else await snapshot.adapter.write(relativePath, content);
    }
    await snapshot.adapter.replaceOwnership(snapshot.ownership);
  }
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
