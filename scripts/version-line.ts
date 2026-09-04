export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[] | null;
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Optional leading v, optional prerelease, optional (ignored) build metadata. */
export function parseVersion(raw: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : null,
  };
}

function compareParsedVersions(
  left: ParsedVersion,
  right: ParsedVersion,
  compareText: (a: string, b: string) => number,
): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (left.prerelease === null && right.prerelease === null) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const a = left.prerelease[i];
    const b = right.prerelease[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aIsNumeric = /^\d+$/.test(a);
    const bIsNumeric = /^\d+$/.test(b);
    if (aIsNumeric && bIsNumeric) {
      const difference = Number(a) - Number(b);
      if (difference !== 0) return difference;
      continue;
    }
    if (aIsNumeric !== bIsNumeric) return aIsNumeric ? -1 : 1;
    const difference = compareText(a, b);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Strict ordering for release decisions. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  if (!a) throw new Error(`unparseable release version: ${JSON.stringify(left)}`);
  const b = parseVersion(right);
  if (!b) throw new Error(`unparseable release version: ${JSON.stringify(right)}`);
  return compareParsedVersions(a, b, (x, y) => x < y ? -1 : x > y ? 1 : 0);
}

/** Lenient ordering for historical tag sets. */
export function compareTagsLenient(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) {
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
  }
  return compareParsedVersions(a, b, (x, y) => x.localeCompare(y));
}

/**
 * The version a development line carries once `released` exists.
 *
 *   X.Y.Z-preview.*  ->  X.Y.Z
 *   X.Y.Z (stable)   ->  X.(Y+1).0
 */
export function nextDevelopmentVersion(released: string): string {
  const parsed = parseVersion(released);
  if (!parsed) throw new Error(`released version is not parseable: ${JSON.stringify(released)}`);
  return parsed.prerelease === null
    ? `${parsed.major}.${parsed.minor + 1}.0`
    : `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}
