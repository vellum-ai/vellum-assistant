const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "with",
]);

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function tokenize(value: string): string[] {
  const normalized = value.toLowerCase().replace(/[^a-z0-9\s-]/g, " ");
  return normalized
    .split(/[\s-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

export function uniqueTokens(values: string[]): string[] {
  return Array.from(new Set(values.flatMap(tokenize)));
}

export function extractSnippet(body: string, query: string, maxLen = 180): string {
  const source = normalizeText(body);
  if (!source) {
    return "";
  }

  const tokens = uniqueTokens([query]);
  if (tokens.length === 0) {
    return source.length <= maxLen ? source : `${source.slice(0, maxLen - 1)}...`;
  }

  const lower = source.toLowerCase();
  let matchIndex = -1;

  for (const token of tokens) {
    const idx = lower.indexOf(token.toLowerCase());
    if (idx !== -1 && (matchIndex === -1 || idx < matchIndex)) {
      matchIndex = idx;
    }
  }

  if (matchIndex === -1) {
    return source.length <= maxLen ? source : `${source.slice(0, maxLen - 1)}...`;
  }

  const contextBefore = Math.floor(maxLen * 0.4);
  const start = Math.max(0, matchIndex - contextBefore);
  const end = Math.min(source.length, start + maxLen);
  const snippet = source.slice(start, end);

  const prefix = start > 0 ? "..." : "";
  const suffix = end < source.length ? "..." : "";

  return `${prefix}${snippet}${suffix}`;
}
