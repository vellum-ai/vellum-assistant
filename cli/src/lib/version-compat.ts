/**
 * Parse a version string into { major, minor, patch } components.
 * Handles optional `v` prefix (e.g., "v1.2.3" or "1.2.3").
 * Returns null if the string cannot be parsed as semver.
 */
export function parseVersion(
  version: string,
): { major: number; minor: number; patch: number } | null {
  const stripped = version.replace(/^[vV]/, "");
  const segments = stripped.split(".");

  if (segments.length < 2) {
    return null;
  }

  const major = parseInt(segments[0], 10);
  const minor = parseInt(segments[1], 10);
  const patch = segments.length >= 3 ? parseInt(segments[2], 10) : 0;

  if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
    return null;
  }

  return { major, minor, patch };
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
