import type {
  AgentAdapter,
  Artifact,
  OwnershipEntry,
  PreparedManifest,
  SyncChange,
} from "../domain.js";
import { HivemndError } from "../errors.js";
import { sha256 } from "./hash.js";
import { isArtifactDesired } from "./delivery-targets.js";

export class SyncPlanner {
  async plan(
    manifest: PreparedManifest,
    adapters: readonly AgentAdapter[],
    options: {
      readonly adoptExisting: boolean;
      readonly clientVersion?: string;
    } = { adoptExisting: false },
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
        isArtifactDesired(artifact, adapter, options.clientVersion),
      );
      validateDestinationAssignments(desired, adapter.name);
      for (const artifact of desired) {
        const current = await adapter.read(artifact.relativePath);
        const owned = ownership.get(artifact.relativePath);
        const disposition = classifyDesiredArtifact(
          artifact,
          current,
          owned,
          options.adoptExisting,
        );
        changes.push({
          artifact,
          agent: adapter.kind,
          destinationName: adapter.name,
          relativePath: artifact.relativePath,
          destination: adapter.destination(artifact.relativePath),
          ...disposition,
        });
        ownership.delete(artifact.relativePath);
      }

      for (const owned of ownership.values()) {
        changes.push({
          owned,
          agent: adapter.kind,
          destinationName: adapter.name,
          relativePath: owned.relativePath,
          destination: adapter.destination(owned.relativePath),
          kind: "remove",
        });
      }
    }
    return changes;
  }
}

function classifyDesiredArtifact(
  artifact: Artifact,
  current: Uint8Array | undefined,
  ownership: OwnershipEntry | undefined,
  adoptExisting: boolean,
): Pick<SyncChange, "kind" | "conflictReason"> {
  if (current === undefined) return { kind: "create" };

  const currentSha256 = sha256(current);
  if (!ownership) {
    return adoptExisting && currentSha256 === artifact.sha256
      ? { kind: "adopt" }
      : { kind: "conflict", conflictReason: "unmanaged-existing-file" };
  }

  if (ownership.logicalId !== artifact.logicalId) return { kind: "update" };
  return {
    kind: currentSha256 === artifact.sha256 ? "unchanged" : "update",
  };
}

function validateManifestUniqueness(artifacts: readonly Artifact[]): void {
  const versionIds = new Set<string>();
  const logicalIds = new Set<string>();
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
  }
}

function validateDestinationAssignments(
  artifacts: readonly Artifact[],
  destinationName: string,
): void {
  const paths = new Set<string>();
  for (const artifact of artifacts) {
    if (paths.has(artifact.relativePath)) {
      throw new HivemndError(
        "MANIFEST_INVALID",
        `Duplicate artifact assignment in manifest: ${destinationName}:${artifact.relativePath}`,
      );
    }
    paths.add(artifact.relativePath);
  }
}
