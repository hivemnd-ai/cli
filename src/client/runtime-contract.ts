import { HivemndError } from "../errors.js";
import { isBoundedSemver } from "../version/semver.js";

export const HIVEMND_CLIENT_VERSION_HEADER = "Hivemnd-Client-Version";
export const HIVEMND_CLIENT_FEATURES_HEADER = "Hivemnd-Client-Features";

export const clientTechnicalFeatures = ["exact-delivery-targets-v1"] as const;
export type ClientTechnicalFeature = (typeof clientTechnicalFeatures)[number];

export interface ClientRuntimeMetadata {
  readonly clientVersion: string;
  readonly clientFeatures: readonly string[];
}

const MAX_FEATURES_BYTES = 128;

export function clientRuntimeHeaders(
  metadata: ClientRuntimeMetadata | undefined,
): Readonly<Record<string, string>> {
  if (!metadata) return {};
  if (!isBoundedSemver(metadata.clientVersion)) {
    throw new HivemndError(
      "CONFIG_INVALID",
      "Hivemnd client version metadata must be bounded strict SemVer",
    );
  }
  const features = [...new Set(metadata.clientFeatures)].sort();
  const serializedFeatures = features.join(",");
  if (Buffer.byteLength(serializedFeatures) > MAX_FEATURES_BYTES) {
    throw new HivemndError(
      "CONFIG_INVALID",
      "Hivemnd client feature metadata is too large",
    );
  }
  const allowed = new Set<string>(clientTechnicalFeatures);
  if (features.some((feature) => !allowed.has(feature))) {
    throw new HivemndError(
      "CONFIG_INVALID",
      "Hivemnd client feature metadata contains an unsupported value",
    );
  }
  return {
    [HIVEMND_CLIENT_VERSION_HEADER]: metadata.clientVersion,
    ...(serializedFeatures
      ? { [HIVEMND_CLIENT_FEATURES_HEADER]: serializedFeatures }
      : {}),
  };
}
