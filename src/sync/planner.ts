import type {
  AgentAdapter,
  Artifact,
  ConflictReason,
  OwnershipEntry,
  PreparedManifest,
  SyncChange,
} from "../domain.js";
import { HivemndError } from "../errors.js";
import { sha256 } from "./hash.js";

export class SyncPlanner {
  async plan(
    manifest: PreparedManifest,
    adapters: readonly AgentAdapter[],
    options: { readonly adoptExisting: boolean } = { adoptExisting: false },
  ): Promise<readonly SyncChange[]> {
    validateManifestUniqueness(manifest.artifacts);
    const changes: SyncChange[] = [];

    for (const adapter of adapters) {
      const ownership = new Map(
        (await adapter.readOwnership()).map((entry) => [
          entry.relativePath,
          entry,
        ]),
      );
      const desired = manifest.artifacts.filter((artifact) =>
        artifact.targets.includes(adapter.kind),
      );
      for (const artifact of desired) {
        const current = await adapter.read(artifact.relativePath);
        const owned = ownership.get(artifact.relativePath);
        const conflictReason = findConflictReason(
          artifact.logicalId,
          current,
          owned,
        );
        const adopt =
          options.adoptExisting &&
          current !== undefined &&
          owned === undefined &&
          sha256(current) === artifact.sha256;
        changes.push({
          artifact,
          agent: adapter.kind,
          destinationName: adapter.name,
          relativePath: artifact.relativePath,
          destination: adapter.destination(artifact.relativePath),
          kind: adopt
            ? "adopt"
            : conflictReason
              ? "conflict"
              : current === undefined
                ? "create"
                : sha256(current) === artifact.sha256
                  ? "unchanged"
                  : "update",
          ...(conflictReason && !adopt ? { conflictReason } : {}),
        });
        ownership.delete(artifact.relativePath);
      }

      for (const owned of ownership.values()) {
        const current = await adapter.read(owned.relativePath);
        const conflictReason = findRemovalConflict(current, owned);
        changes.push({
          owned,
          agent: adapter.kind,
          destinationName: adapter.name,
          relativePath: owned.relativePath,
          destination: adapter.destination(owned.relativePath),
          kind: conflictReason ? "conflict" : "remove",
          ...(conflictReason ? { conflictReason } : {}),
        });
      }
    }
    return changes;
  }
}

function validateManifestUniqueness(artifacts: readonly Artifact[]): void {
  const versionIds = new Set<string>();
  const logicalIds = new Set<string>();
  const assignments = new Set<string>();
  for (const artifact of artifacts) {
    if (versionIds.has(artifact.artifactVersionId)) {
      throw new HivemndError(
        "MANIFEST_INVALID",
        `Duplicate artifact version in manifest: ${artifact.artifactVersionId}`,
      );
    }
    if (logicalIds.has(artifact.logicalId)) {
      throw new HivemndError(
        "MANIFEST_INVALID",
        `Duplicate logical artifact in manifest: ${artifact.logicalId}`,
      );
    }
    versionIds.add(artifact.artifactVersionId);
    logicalIds.add(artifact.logicalId);
    for (const agent of artifact.targets) {
      const assignment = `${agent}:${artifact.relativePath}`;
      if (assignments.has(assignment)) {
        throw new HivemndError(
          "MANIFEST_INVALID",
          `Duplicate artifact assignment in manifest: ${assignment}`,
        );
      }
      assignments.add(assignment);
    }
  }
}

function findConflictReason(
  logicalId: string,
  current: Uint8Array | undefined,
  ownership: OwnershipEntry | undefined,
): ConflictReason | undefined {
  if (current === undefined)
    return ownership ? "owned-file-missing" : undefined;
  if (!ownership) return "unmanaged-existing-file";
  if (ownership.logicalId !== logicalId) return "artifact-ownership-mismatch";
  if (sha256(current) !== ownership.sha256) return "owned-content-drift";
  return undefined;
}

function findRemovalConflict(
  current: Uint8Array | undefined,
  ownership: OwnershipEntry,
): ConflictReason | undefined {
  if (current === undefined) return "owned-file-missing";
  return sha256(current) === ownership.sha256
    ? undefined
    : "owned-content-drift";
}
