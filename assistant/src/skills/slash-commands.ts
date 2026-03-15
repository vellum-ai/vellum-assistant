/**
 * Parse whether user input starts with a slash-like command token.
 *
 * Rules:
 * - Trim leading whitespace.
 * - Only inspect the first whitespace-delimited token.
 * - A candidate token must begin with `/`.
 * - Return `none` for empty input.
 */

export function extractLeadingToken(input: string): string | null {
  const trimmed = input.trimStart();
  if (!trimmed) return null;
  const firstToken = trimmed.split(/\s/)[0];
  return firstToken || null;
}

export function parseSlashCandidate(input: string): {
  kind: "none" | "candidate";
  token?: string;
} {
  const token = extractLeadingToken(input);
  if (!token || !token.startsWith("/")) {
    return { kind: "none" };
  }
  if (isPathLikeSlashToken(token)) {
    return { kind: "none" };
  }
  const id = token.slice(1);
  if (!isValidSlashSkillId(id)) {
    return { kind: "none" };
  }
  return { kind: "candidate", token };
}

/** Validate that a slash skill ID starts with alphanumeric and contains only [A-Za-z0-9._-] */
export function isValidSlashSkillId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

/** Detect filesystem-like paths: tokens containing more than one `/` */
export function isPathLikeSlashToken(token: string): boolean {
  // Count slashes — a single leading `/` is expected, but any additional `/` means it's a path
  const slashCount = token.split("/").length - 1;
  return slashCount > 1;
}
