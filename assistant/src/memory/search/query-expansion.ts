// Stop words filtered out during query expansion to focus on meaningful keywords.
const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "will",
  "would",
  "could",
  "should",
  "can",
  "may",
  "might",
  "shall",
  "that",
  "this",
  "these",
  "those",
  "which",
  "what",
  "how",
  "who",
  "whom",
  "where",
  "when",
  "why",
  "it",
  "its",
  "i",
  "me",
  "my",
  "we",
  "us",
  "our",
  "you",
  "your",
  "he",
  "she",
  "they",
  "them",
  "his",
  "her",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "with",
  "by",
  "from",
  "about",
  "and",
  "or",
  "but",
  "not",
  "so",
  "if",
  "then",
]);

/**
 * Extract meaningful keywords from a conversational query by tokenizing,
 * stripping punctuation, and removing stop words.
 *
 * Returns `["*"]` for empty input (match-all fallback).
 */
export function expandQueryForFTS(query: string): string[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return ["*"];
  }

  const tokens = trimmed
    .split(/\s+/)
    .map((token) => token.replace(/[^\w]/g, ""))
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return ["*"];
  }

  const keywords = tokens.filter(
    (token) => !STOP_WORDS.has(token.toLowerCase()),
  );

  // If every token was a stop word, return the original tokens rather than
  // discarding the entire query.
  if (keywords.length === 0) {
    return tokens;
  }

  return keywords;
}

/**
 * Build an FTS5 query string from keywords using OR operators.
 *
 * Example: `["discuss", "API", "design"]` -> `"discuss" OR "API" OR "design"`
 */
export function buildFTSQuery(keywords: string[]): string {
  if (keywords.length === 0) {
    return '"*"';
  }

  return keywords.map((kw) => `"${kw.replaceAll('"', "")}"`).join(" OR ");
}
