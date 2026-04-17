/**
 * Parse a version string into { major, minor, patch, pre } components.
 * Handles optional `v`/`V` prefix (e.g., "v1.2.3" or "1.2.3").
 * Pre-release suffixes are captured (e.g., "0.6.0-staging.5" -> pre: "staging.5").
 * Returns null if the string cannot be parsed as semver.
 */
export function parseVersion(
  version: string,
): { major: number; minor: number; patch: number; pre: string | null } | null {
  const stripped = version.replace(/^[vV]/, "");
  const [core, ...rest] = stripped.split("-");
  const pre = rest.length > 0 ? rest.join("-") : null;
  const segments = (core ?? "").split(".");

  if (segments.length < 2) {
    return null;
  }

  const major = parseInt(segments[0], 10);
  const minor = parseInt(segments[1], 10);
  const patch = segments.length >= 3 ? parseInt(segments[2], 10) : 0;

  if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
    return null;
  }

  return { major, minor, patch, pre };
}

/**
 * Compare two pre-release strings per semver S11:
 *   - Dot-separated identifiers compared left to right.
 *   - Both numeric -> compare as integers.
 *   - Both non-numeric -> compare lexically.
 *   - Numeric vs non-numeric -> numeric sorts lower (S11.4.4).
 *   - Fewer identifiers sorts earlier when all preceding are equal.
 */
function comparePreRelease(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    if (i >= pa.length) return -1; // a has fewer fields -> a < b
    if (i >= pb.length) return 1;
    const aIsNum = /^\d+$/.test(pa[i]);
    const bIsNum = /^\d+$/.test(pb[i]);
    if (aIsNum && bIsNum) {
      const diff = Number(pa[i]) - Number(pb[i]);
      if (diff !== 0) return diff;
    } else if (aIsNum !== bIsNum) {
      return aIsNum ? -1 : 1; // numeric < non-numeric per S11.4.4
    } else {
      const cmp = (pa[i] ?? "").localeCompare(pb[i] ?? "");
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

/**
 * Compare two semver version strings.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 *
 * Handles pre-release suffixes per semver spec:
 *   - `0.6.0-staging.1 < 0.6.0` (pre-release < release)
 *   - `0.6.0-staging.1 < 0.6.0-staging.2` (numeric postfix comparison)
 *
 * Returns null if either version cannot be parsed.
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return null;

  const majorDiff = pa.major - pb.major;
  if (majorDiff !== 0) return majorDiff;
  const minorDiff = pa.minor - pb.minor;
  if (minorDiff !== 0) return minorDiff;
  const patchDiff = pa.patch - pb.patch;
  if (patchDiff !== 0) return patchDiff;

  // Same major.minor.patch -- compare pre-release
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre !== null && pb.pre === null) return -1; // pre-release < release
  if (pa.pre === null && pb.pre !== null) return 1;
  return comparePreRelease(pa.pre!, pb.pre!);
}

/**
 * Lenient version parser that never returns null. Missing segments default to 0,
 * and non-numeric segments are treated as 0. Matches the legacy parseSemverParts
 * behavior where any string produces a usable version triple.
 */
function parseVersionLenient(version: string): {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
} {
  const stripped = version.replace(/^[vV]/, "");
  const [core, ...rest] = stripped.split("-");
  const pre = rest.length > 0 ? rest.join("-") : null;
  const segs = (core ?? "").split(".").map(Number);
  return {
    major: segs[0] || 0,
    minor: segs[1] || 0,
    patch: segs[2] || 0,
    pre,
  };
}

/**
 * Compare two semver strings leniently. Always returns a number (never null),
 * making it safe for Array.sort(). Missing version segments default to 0
 * (e.g., "1" is treated as "1.0.0").
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseVersionLenient(a);
  const pb = parseVersionLenient(b);

  const majorDiff = pa.major - pb.major;
  if (majorDiff !== 0) return majorDiff;
  const minorDiff = pa.minor - pb.minor;
  if (minorDiff !== 0) return minorDiff;
  const patchDiff = pa.patch - pb.patch;
  if (patchDiff !== 0) return patchDiff;

  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre !== null && pb.pre === null) return -1;
  if (pa.pre === null && pb.pre !== null) return 1;
  return comparePreRelease(pa.pre!, pb.pre!);
}

/**
 * Check whether two version strings are compatible.
 * Compatibility requires matching major AND minor versions.
 * Patch differences are allowed.
 * Returns false if either version cannot be parsed.
 */
export function isVersionCompatible(
  clientVersion: string,
  serviceGroupVersion: string,
): boolean {
  const a = parseVersion(clientVersion);
  const b = parseVersion(serviceGroupVersion);

  if (a === null || b === null) {
    return false;
  }

  return a.major === b.major && a.minor === b.minor;
}
