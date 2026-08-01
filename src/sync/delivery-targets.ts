import type {
  AgentAdapter,
  DestinationScope,
  InstallScope,
  ManifestArtifact,
  ManifestDeliveryTarget,
} from "../domain.js";
import { assertDefined, HivemndError } from "../errors.js";
import { UPDATE_COMMAND } from "../update/daily-update-checker.js";
import { compareSemver, parseSemver } from "../version/semver.js";

type DeliveryDestination = Pick<AgentAdapter, "kind" | "scope">;

export function destinationInstallScope(scope: DestinationScope): InstallScope {
  return scope === "workspace" ? "workspace" : "user";
}

export function matchingDeliveryTargets(
  artifact: ManifestArtifact,
  destination: DeliveryDestination,
): readonly ManifestDeliveryTarget[] {
  const installScope = destinationInstallScope(destination.scope);
  return artifact.deliveryTargets.filter(
    (target) =>
      target.clientKind === destination.kind &&
      (target.installScope === "any" || target.installScope === installScope),
  );
}

export function isDeliveryCompatible(
  target: ManifestDeliveryTarget,
  clientVersion: string,
): boolean {
  return (
    target.minimumClientVersion === undefined ||
    compareSemver(clientVersion, target.minimumClientVersion) >= 0
  );
}

export function isArtifactDesired(
  artifact: ManifestArtifact,
  destination: DeliveryDestination,
  clientVersion?: string,
): boolean {
  const targets = matchingDeliveryTargets(artifact, destination);
  return targets.some(
    (target) =>
      clientVersion === undefined ||
      isDeliveryCompatible(target, clientVersion),
  );
}

export function assertCompatibleDeliveryTargets(
  artifacts: readonly ManifestArtifact[],
  destinations: readonly DeliveryDestination[],
  clientVersion: string,
): void {
  if (!parseSemver(clientVersion)) {
    throw updateRequired(clientVersion, clientVersion);
  }
  for (const artifact of artifacts) {
    for (const destination of destinations) {
      const targets = matchingDeliveryTargets(artifact, destination);
      if (
        targets.length === 0 ||
        targets.some((target) => isDeliveryCompatible(target, clientVersion))
      ) {
        continue;
      }
      const minimum = targets
        .map((target) => target.minimumClientVersion)
        .filter((value): value is string => value !== undefined)
        .sort(compareSemver)[0];
      assertDefined(minimum, "Applicable delivery target minimum disappeared");
      throw updateRequired(clientVersion, minimum);
    }
  }
}

function updateRequired(
  installedVersion: string,
  minimumVersion: string,
): HivemndError {
  return new HivemndError(
    "CLIENT_UPDATE_REQUIRED",
    `Hivemnd CLI ${minimumVersion} or newer is required; installed: ${installedVersion}. Run: ${UPDATE_COMMAND}`,
  );
}
