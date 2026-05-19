export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

/**
 * Parse a version string into semver components with optional pre-release suffix.
 * Handles optional `v`/`V` prefix. Returns null if the string cannot be parsed.
 */
export function parseSemver(v: string): ParsedSemver | null {
  const stripped = v.replace(/^[vV]/, "");
  const [core, ...rest] = stripped.split("-");
  const pre = rest.length > 0 ? rest.join("-") : null;
  const match = (core ?? "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre };
}

/**
 * Compare two pre-release strings per semver §11:
 *   - Dot-separated identifiers compared left to right.
 *   - Both numeric → compare as integers.
 *   - Both non-numeric → compare lexically.
 *   - Numeric vs non-numeric → numeric sorts lower (§11.4.4).
 *   - Fewer identifiers sorts earlier when all preceding are equal.
 */
export function comparePreRelease(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = pa[i];
    const bi = pb[i];
    if (ai === undefined) return -1; // a has fewer fields -> a < b
    if (bi === undefined) return 1;
    const aIsNum = /^\d+$/.test(ai);
    const bIsNum = /^\d+$/.test(bi);
    if (aIsNum && bIsNum) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) return diff;
    } else if (aIsNum !== bIsNum) {
      return aIsNum ? -1 : 1;
    } else {
      if (ai < bi) return -1;
      if (ai > bi) return 1;
    }
  }
  return 0;
}

/**
 * Compare two parsed semver objects. Returns negative if a < b, 0 if equal, positive if a > b.
 * Handles pre-release per semver §11: pre-release < release.
 */
export function compareParsed(a: ParsedSemver, b: ParsedSemver): number {
  const majorDiff = a.major - b.major;
  if (majorDiff !== 0) return majorDiff;
  const minorDiff = a.minor - b.minor;
  if (minorDiff !== 0) return minorDiff;
  const patchDiff = a.patch - b.patch;
  if (patchDiff !== 0) return patchDiff;
  if (a.pre === null && b.pre === null) return 0;
  if (a.pre !== null && b.pre === null) return -1;
  if (a.pre === null && b.pre !== null) return 1;
  return comparePreRelease(a.pre!, b.pre!);
}
