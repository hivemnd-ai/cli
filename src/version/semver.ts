export interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (number | string)[];
}

export const MAX_SEMVER_BYTES = 128;

const semanticVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemver(value: string): SemanticVersion | undefined {
  const match = semanticVersionPattern.exec(value);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
      ? match[4]
          .split(".")
          .map((identifier) =>
            /^\d+$/.test(identifier) ? Number(identifier) : identifier,
          )
      : [],
  };
}

export function isBoundedSemver(value: string): boolean {
  return (
    Buffer.byteLength(value) <= MAX_SEMVER_BYTES &&
    parseSemver(value) !== undefined
  );
}

export function isStableSemver(value: string): boolean {
  const parsed = parseSemver(value);
  return parsed?.prerelease.length === 0;
}

export function compareSemver(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) {
    throw new Error(`Invalid semantic version comparison: ${left}, ${right}`);
  }
  for (const field of ["major", "minor", "patch"] as const) {
    if (parsedLeft[field] !== parsedRight[field]) {
      return parsedLeft[field] > parsedRight[field] ? 1 : -1;
    }
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

function comparePrerelease(
  left: readonly (number | string)[],
  right: readonly (number | string)[],
): number {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0;
    return left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    if (typeof leftIdentifier === "number") {
      return typeof rightIdentifier === "number" &&
        leftIdentifier > rightIdentifier
        ? 1
        : -1;
    }
    if (typeof rightIdentifier === "number") return 1;
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }
  return 0;
}
