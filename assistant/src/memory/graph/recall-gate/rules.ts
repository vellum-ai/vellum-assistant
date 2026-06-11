/**
 * Five hand-rules for the recall-decision gate.
 * Each returns `{ skip: true, rule }` on match, or `null` to fall through.
 * Evaluated in order; first match wins. Default decision is RETRIEVE.
 */

import { isMetaQuery } from "./meta-queries.js";

export interface RuleResult {
  skip: boolean;
  rule: string;
}

// ---------------------------------------------------------------------------
// Rule 1 — Pure tool-result / no user text
// ---------------------------------------------------------------------------

/**
 * The actual short-circuit for empty/tool-result is at lines 477-483 in
 * conversation-graph-memory.ts and stays there. This rule exists so the
 * gate's log captures turns that WOULD be skipped even when the gate runs
 * after the existing check (e.g. if the existing check is relaxed later).
 */
export function ruleToolResultOnly(userText: string): RuleResult | null {
  if (userText.trim().length === 0) {
    return { skip: true, rule: "tool-result-only" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule 2 — First turn of session, short, no entities
// ---------------------------------------------------------------------------

export function ruleFirstTurnOneShot(
  userText: string,
  turn: number,
  hasEntities: boolean,
): RuleResult | null {
  if (turn === 1 && !hasEntities && userText.trim().length < 40) {
    return { skip: true, rule: "first-turn-one-shot" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule 3 — Meta-query (e.g. "what model", "/help")
// ---------------------------------------------------------------------------

export function ruleMetaQuery(userText: string): RuleResult | null {
  if (isMetaQuery(userText)) {
    return { skip: true, rule: "meta-query" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule 4 — Continuation / pure transform of last assistant turn
// ---------------------------------------------------------------------------

const IMPERATIVE_OPENER_RE =
  /^(shorter|longer|in [a-z]+|as a [a-z]+|rephrase|summari[sz]e|make it|translate|reformat|tldr|tl;dr)\b/i;

/**
 * Lightweight ROUGE-L: ratio of longest common subsequence length to the
 * length of the shorter text (in words). Returns 0-1.
 */
export function rougeL(a: string, b: string): number {
  const wordsA = a.toLowerCase().split(/\s+/).filter(Boolean);
  const wordsB = b.toLowerCase().split(/\s+/).filter(Boolean);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;

  const m = wordsA.length;
  const n = wordsB.length;
  // LCS via DP
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (wordsA[i - 1] === wordsB[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }
  const lcsLen = dp[m]![n]!;
  return lcsLen / Math.min(m, n);
}

export function ruleContinuationTransform(
  userText: string,
  lastAssistantText: string,
): RuleResult | null {
  if (lastAssistantText.trim().length === 0) return null;

  const hasImperativeOpener = IMPERATIVE_OPENER_RE.test(userText.trim());
  if (!hasImperativeOpener) return null;

  const similarity = rougeL(userText, lastAssistantText);
  if (similarity > 0.6) {
    return { skip: true, rule: "continuation-transform" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule 5 — Small-talk heuristic
// ---------------------------------------------------------------------------

const SMALL_TALK_OPENER_RE =
  /^(hi|hey|hello|thanks|thx|ty|good (morning|night|evening|afternoon)|ok|cool|nice|got it|sounds good|lol|haha|sure|yep|yeah|np|no problem|alright)\b/i;

export function ruleSmallTalk(
  userText: string,
  hasEntities: boolean,
): RuleResult | null {
  const trimmed = userText.trim();
  if (
    trimmed.length < 40 &&
    !hasEntities &&
    !trimmed.includes("?") &&
    SMALL_TALK_OPENER_RE.test(trimmed)
  ) {
    return { skip: true, rule: "small-talk" };
  }
  return null;
}
