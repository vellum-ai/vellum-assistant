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

export function parseSlashCandidate(input: string): { kind: 'none' | 'candidate'; token?: string } {
  const token = extractLeadingToken(input);
  if (!token || !token.startsWith('/')) {
    return { kind: 'none' };
  }
  return { kind: 'candidate', token };
}
