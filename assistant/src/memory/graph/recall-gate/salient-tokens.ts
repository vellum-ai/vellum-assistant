/**
 * Deterministic salient-token extractor for the recall-gate safety floor.
 *
 * "Salient" = tokens that strongly suggest the user is referencing something
 * specific that memory might know about. When any salient token from the
 * last N turns appears in the new user message, the safety floor overrides
 * a skip decision to RECALL.
 *
 * Categories:
 *   - Capitalized non-stopword tokens (proper nouns, project names)
 *   - File paths (/foo/bar.ts, ./relative)
 *   - URLs (https://..., http://...)
 *   - Quoted spans ("some phrase")
 *   - Allowlist patterns: PR numbers (#12345), ticket IDs (LUM-123, INT-456),
 *     skill slugs, project identifiers
 */

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "is",
  "it",
  "its",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "this",
  "that",
  "these",
  "those",
  "i",
  "you",
  "he",
  "she",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "our",
  "their",
  "what",
  "which",
  "who",
  "whom",
  "where",
  "when",
  "why",
  "how",
  "not",
  "no",
  "yes",
  "if",
  "then",
  "else",
  "so",
  "as",
  "just",
  "also",
  "than",
  "too",
  "very",
  "about",
  "up",
  "out",
  "all",
  "some",
  "any",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "into",
  "over",
  "after",
  "before",
  "between",
  "under",
  "again",
  "here",
  "there",
  "once",
  "ok",
  "okay",
  "sure",
  "yeah",
  "yep",
  "nope",
  "hi",
  "hey",
  "hello",
  "thanks",
  "thank",
  "please",
  "sorry",
  "well",
  "now",
  "still",
  "already",
  "yet",
]);

const FILE_PATH_RE = /(?:^|\s)((?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.\w+)/g;
const URL_RE = /https?:\/\/[^\s)>\]]+/g;
const QUOTED_SPAN_RE = /"([^"]{2,})"/g;
const PR_NUMBER_RE = /#\d{2,}/g;
const TICKET_ID_RE = /\b[A-Z]{2,}-\d+\b/g;
const CAPITALIZED_WORD_RE = /\b([A-Z][a-zA-Z]{1,})\b/g;

export function extractSalientTokens(text: string): Set<string> {
  const tokens = new Set<string>();

  for (const m of text.matchAll(FILE_PATH_RE)) {
    tokens.add(m[1]!);
  }

  for (const m of text.matchAll(URL_RE)) {
    tokens.add(m[0]);
  }

  for (const m of text.matchAll(QUOTED_SPAN_RE)) {
    tokens.add(m[1]!);
  }

  for (const m of text.matchAll(PR_NUMBER_RE)) {
    tokens.add(m[0]);
  }

  for (const m of text.matchAll(TICKET_ID_RE)) {
    tokens.add(m[0]);
  }

  for (const m of text.matchAll(CAPITALIZED_WORD_RE)) {
    const word = m[1]!;
    if (!STOPWORDS.has(word.toLowerCase())) {
      tokens.add(word);
    }
  }

  return tokens;
}

/**
 * Check if any salient token from the context set appears in the user message.
 * Returns the matched tokens (empty set if no overlap).
 */
export function findSalientOverlap(
  userText: string,
  contextTokens: Set<string>,
): Set<string> {
  if (contextTokens.size === 0) return new Set();

  const matched = new Set<string>();
  const lowerText = userText.toLowerCase();

  for (const token of contextTokens) {
    if (lowerText.includes(token.toLowerCase())) {
      matched.add(token);
    }
  }
  return matched;
}
