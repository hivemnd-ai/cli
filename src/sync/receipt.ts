import { z } from "zod";
import type {
  Artifact,
  DeliveryObservationOperation,
  DeliveryObservationReceipt,
  DeliveryObservationStatus,
  DestinationConfig,
  HivemndConfig,
  SyncChange,
} from "../domain.js";
import { HivemndError } from "../errors.js";
import {
  destinationInstallScope,
  isArtifactDesired,
} from "./delivery-targets.js";

const uuidSchema = z.uuid();

export interface BuildDeliveryObservationReceiptOptions {
  readonly idempotencyKey: string;
  readonly clientSequence: number;
  readonly releaseId: string;
  readonly status: DeliveryObservationStatus;
  readonly config: HivemndConfig;
  readonly selectedDestinationNames: readonly string[];
  readonly changes: readonly SyncChange[];
  readonly alwaysContextArtifacts?: readonly Artifact[];
  readonly alwaysContextResult?: "applied" | "unchanged" | "failed";
}

export function buildDeliveryObservationReceipt(
  options: BuildDeliveryObservationReceiptOptions,
): DeliveryObservationReceipt {
  const selected = new Set(options.selectedDestinationNames);
  const destinations = options.config.destinations.map((destination) => {
    const id = requireUuid(destination.id, `destination ${destination.name}`);
    const isSelected = selected.has(destination.name);
    const operations = isSelected
      ? operationsForDestination(options, destination)
      : [];
    return {
      id,
      label: destination.name,
      clientKind: destination.agent,
      installScope: destinationInstallScope(destination.scope),
      selected: isSelected,
      operations,
    };
  });
  return {
    idempotencyKey: requireUuid(options.idempotencyKey, "receipt"),
    clientSequence: options.clientSequence,
    releaseId: requireUuid(options.releaseId, "release"),
    status: options.status,
    destinations,
  };
}

function operationsForDestination(
  options: BuildDeliveryObservationReceiptOptions,
  destination: DestinationConfig,
): readonly DeliveryObservationOperation[] {
  const operations = new Map<string, DeliveryObservationOperation>();
  for (const change of options.changes.filter(
    (candidate) => candidate.destinationName === destination.name,
  )) {
    const operation = operationForChange(change, options.status);
    if (!operation) continue;
    const existing = operations.get(operation.artifactId);
    if (
      !existing ||
      operationPriority(operation) > operationPriority(existing)
    ) {
      operations.set(operation.artifactId, operation);
    }
  }
  if (options.alwaysContextResult) {
    for (const artifact of options.alwaysContextArtifacts ?? []) {
      if (
        !isArtifactDesired(artifact, {
          kind: destination.agent,
          scope: destination.scope,
        })
      ) {
        continue;
      }
      const operation = alwaysContextOperation(
        artifact,
        options.alwaysContextResult,
      );
      operations.set(operation.artifactId, operation);
    }
  }
  return [...operations.values()].sort((left, right) =>
    left.artifactId.localeCompare(right.artifactId),
  );
}

function operationForChange(
  change: SyncChange,
  status: DeliveryObservationStatus,
): DeliveryObservationOperation | undefined {
  if (status === "failed") return failedOperation(change);
  if (status === "blocked") {
    if (change.kind === "unchanged") return normalOperation(change);
    if (change.kind !== "conflict") return undefined;
  }
  return normalOperation(change);
}

function normalOperation(
  change: SyncChange,
): DeliveryObservationOperation | undefined {
  switch (change.kind) {
    case "create":
      return desiredOperation(change, "applied", "created", true);
    case "update":
      return desiredOperation(change, "applied", "updated", true);
    case "adopt":
      return desiredOperation(change, "applied", "adopted", true);
    case "unchanged":
      return desiredOperation(change, "unchanged", "already_current", true);
    case "remove":
      return ownedOperation(change, "removed", "no_longer_desired", null);
    case "conflict":
      return conflictOperation(change);
  }
}

function conflictOperation(change: SyncChange): DeliveryObservationOperation {
  const reason = change.conflictReason;
  if (!reason) {
    throw new HivemndError(
      "SYNC_FAILED",
      "Artifact conflict is missing its bounded reason",
    );
  }
  if (reason === "unmanaged-existing-file") {
    return desiredOperation(
      change,
      "conflict",
      "unmanaged_existing_file",
      false,
    );
  }
  return ownedOperation(
    change,
    "conflict",
    reason.replaceAll("-", "_") as
      | "owned_file_missing"
      | "owned_content_drift"
      | "artifact_ownership_mismatch",
    change.observedArtifactVersionId ?? null,
  );
}

function failedOperation(
  change: SyncChange,
): DeliveryObservationOperation | undefined {
  if (change.kind === "unchanged") return normalOperation(change);
  if (!["create", "update", "adopt"].includes(change.kind)) return undefined;
  const artifact = requireArtifact(change);
  return {
    artifactId: artifact.logicalId,
    artifactVersionId: artifact.artifactVersionId,
    observedArtifactVersionId:
      change.kind === "adopt"
        ? artifact.artifactVersionId
        : (change.owned?.artifactVersionId ?? null),
    outcome: "failed",
    reason: "local_apply_failed",
  };
}

function alwaysContextOperation(
  artifact: Artifact,
  result: "applied" | "unchanged" | "failed",
): DeliveryObservationOperation {
  return {
    artifactId: artifact.logicalId,
    artifactVersionId: artifact.artifactVersionId,
    observedArtifactVersionId:
      result === "failed" ? null : artifact.artifactVersionId,
    outcome: result,
    reason:
      result === "applied"
        ? "updated"
        : result === "unchanged"
          ? "already_current"
          : "local_apply_failed",
  };
}

function desiredOperation(
  change: SyncChange,
  outcome: "applied" | "unchanged" | "conflict",
  reason:
    | "created"
    | "updated"
    | "adopted"
    | "already_current"
    | "unmanaged_existing_file",
  observed: boolean,
): DeliveryObservationOperation {
  const artifact = requireArtifact(change);
  return {
    artifactId: artifact.logicalId,
    artifactVersionId: artifact.artifactVersionId,
    observedArtifactVersionId: observed ? artifact.artifactVersionId : null,
    outcome,
    reason,
  };
}

function ownedOperation(
  change: SyncChange,
  outcome: "removed" | "conflict",
  reason:
    | "no_longer_desired"
    | "owned_file_missing"
    | "owned_content_drift"
    | "artifact_ownership_mismatch",
  observedArtifactVersionId: string | null,
): DeliveryObservationOperation {
  const owned = change.owned;
  if (!owned) {
    throw new HivemndError(
      "SYNC_FAILED",
      `Missing prior ownership for ${reason}`,
    );
  }
  return {
    artifactId: owned.logicalId,
    artifactVersionId: owned.artifactVersionId,
    observedArtifactVersionId,
    outcome,
    reason,
  };
}

function requireArtifact(change: SyncChange): Artifact {
  if (!change.artifact) {
    throw new HivemndError(
      "SYNC_FAILED",
      `Missing desired artifact for ${change.kind}`,
    );
  }
  return change.artifact;
}

function requireUuid(value: string | undefined, label: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new HivemndError(
      "CONFIG_INVALID",
      `Invalid opaque UUID for ${label}`,
      { cause: parsed.error },
    );
  }
  return parsed.data.toLowerCase();
}

function operationPriority(operation: DeliveryObservationOperation): number {
  return operation.outcome === "conflict" || operation.outcome === "failed"
    ? 2
    : 1;
}
