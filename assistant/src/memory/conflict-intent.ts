/**
 * Shared conflict intent helpers used by both interactive conflict gating and
 * background conflict resolution jobs.
 */

export interface ConflictStatementPair {
  existingStatement: string;
  candidateStatement: string;
}

export function computeConflictRelevance(
  userMessage: string,
  conflict: ConflictStatementPair,
): number {
  const queryTokens = tokenizeForConflictRelevance(userMessage);
  if (queryTokens.size === 0) return 0;
  const existingTokens = tokenizeForConflictRelevance(conflict.existingStatement);
  const candidateTokens = tokenizeForConflictRelevance(conflict.candidateStatement);
  return Math.max(
    overlapRatio(queryTokens, existingTokens),
    overlapRatio(queryTokens, candidateTokens),
  );
}

const NOISE_TOKENS = new Set([
  'http', 'https', 'github', 'gitlab', 'www', 'com', 'org',
  'pull', 'issue', 'ticket',
]);

function tokenizeForConflictRelevance(input: string): Set<string> {
  const tokens = input
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !NOISE_TOKENS.has(token));
  return new Set(tokens);
}

function overlapRatio(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap / Math.max(left.size, right.size);
}

// Action verbs that signal the user is making a deliberate choice.
const ACTION_CUES = new Set([
  'keep', 'use', 'prefer', 'go', 'pick', 'choose', 'take', 'want', 'select',
]);

// Directional/merge cue words mirrored from clarification-resolver.ts heuristics.
const DIRECTIONAL_CUES = new Set([
  'existing', 'old', 'previous', 'first', 'earlier', 'original',
  'candidate', 'new', 'latest', 'second', 'updated', 'instead', 'replace',
  'both', 'merge', 'combine', 'together', 'either', 'mix',
  'option', 'former', 'latter',
]);

const MAX_REPLY_WORD_COUNT = 12;

// Direction-only matches (no action verb) must be very short to avoid
// false positives from unrelated statements that happen to contain
// common words like "new", "old", "option", etc.
const MAX_DIRECTION_ONLY_WORD_COUNT = 4;

// Messages starting with a question word are unlikely to be clarification
// replies even when they lack a trailing question mark.
const QUESTION_WORD_PREFIXES = new Set([
  'what', 'how', 'why', 'where', 'when', 'which', 'who', 'whom', 'whose',
]);

/**
 * Determines whether a user message looks like a deliberate clarification
 * reply (e.g. "keep the new one", "both", "option B").
 */
export function looksLikeClarificationReply(userMessage: string): boolean {
  const trimmed = userMessage.trim();
  if (trimmed.endsWith('?')) return false;

  const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > MAX_REPLY_WORD_COUNT) return false;

  const normalized = words.map((w) => w.replace(/[^a-z]/g, ''));

  // Reject messages that start with a question word (even without '?').
  // Match exact question words or contractions (e.g. "what's", "where's"),
  // but not words that merely share a prefix (e.g. "whichever", "however").
  const firstWord = words[0];
  const firstNorm = normalized[0];
  for (const qw of QUESTION_WORD_PREFIXES) {
    if (firstNorm === qw || (firstWord.startsWith(qw) && "'\u2018\u2019".includes(firstWord[qw.length]))) return false;
  }

  const hasAction = normalized.some((w) => ACTION_CUES.has(w));
  const hasDirection = normalized.some((w) => DIRECTIONAL_CUES.has(w));

  if (hasAction) return true;
  if (hasDirection) return words.length <= MAX_DIRECTION_ONLY_WORD_COUNT;
  return false;
}

/**
 * Conflict resolution should require explicit clarification intent and either:
 * - non-zero topical overlap with the conflict statements, or
 * - a very recent explicit ask from the assistant.
 */
export function shouldAttemptConflictResolution(
  input: {
    clarificationReply: boolean;
    relevance: number;
    wasRecentlyAsked: boolean;
  },
): boolean {
  if (!input.clarificationReply) return false;
  if (input.relevance > 0) return true;
  return input.wasRecentlyAsked;
}
