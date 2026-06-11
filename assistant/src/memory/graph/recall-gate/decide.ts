/**
 * Recall-gate decision orchestrator.
 *
 * Runs the 5-rule cascade, applies the salient-token safety floor, and
 * returns a structured decision. Pure function — no I/O, no side effects.
 */

import type { ContentBlock } from "../../../providers/types.js";
import { redactForLog } from "./redact.js";
import {
  ruleContinuationTransform,
  ruleFirstTurnOneShot,
  ruleMetaQuery,
  ruleSmallTalk,
  ruleToolResultOnly,
} from "./rules.js";
import { extractSalientTokens, findSalientOverlap } from "./salient-tokens.js";

export interface RecallGateDecision {
  skip: boolean;
  rule: string | null;
  safetyFloorHit: boolean;
  safetyFloorTokens: string[];
  redactedUserText: string;
  promptCharCount: number;
  promptTokenEstimate: number;
  hasEntities: boolean;
  hasQuestionMark: boolean;
}

/** How many recent turns to scan for salient-token context. */
const SALIENT_CONTEXT_TURNS = 5;

/**
 * Extract the text content of recent messages for salient-token context.
 * Walks backward through messages, collecting up to N user+assistant turns.
 */
function extractRecentContext(
  messages: Array<{ role: string; content: ContentBlock[] }>,
  maxTurns: number,
): string {
  const texts: string[] = [];
  let turnsSeen = 0;
  for (let i = messages.length - 2; i >= 0 && turnsSeen < maxTurns; i--) {
    const msg = messages[i]!;
    const text = msg.content
      .filter(
        (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
      )
      .map((b) => b.text)
      .join(" ");
    if (text.trim().length > 0) {
      texts.push(text);
    }
    if (msg.role === "user") turnsSeen++;
  }
  return texts.join("\n");
}

export function evaluateRecallGate(
  userText: string,
  lastAssistantText: string,
  messages: Array<{ role: string; content: ContentBlock[] }>,
  turn: number,
): RecallGateDecision {
  const trimmed = userText.trim();
  const charCount = trimmed.length;
  const tokenEstimate = Math.ceil(charCount / 4);
  const userTokens = extractSalientTokens(trimmed);
  const hasEntities = userTokens.size > 0;
  const hasQuestionMark = trimmed.includes("?");
  const redacted = redactForLog(trimmed);

  const defaultResult: RecallGateDecision = {
    skip: false,
    rule: null,
    safetyFloorHit: false,
    safetyFloorTokens: [],
    redactedUserText: redacted,
    promptCharCount: charCount,
    promptTokenEstimate: tokenEstimate,
    hasEntities,
    hasQuestionMark,
  };

  // Run rules in order — first match wins
  const rules = [
    () => ruleToolResultOnly(trimmed),
    () => ruleFirstTurnOneShot(trimmed, turn, hasEntities),
    () => ruleMetaQuery(trimmed),
    () => ruleContinuationTransform(trimmed, lastAssistantText),
    () => ruleSmallTalk(trimmed, hasEntities),
  ];

  let matchedRule: { skip: boolean; rule: string } | null = null;
  for (const rule of rules) {
    const result = rule();
    if (result !== null) {
      matchedRule = result;
      break;
    }
  }

  if (!matchedRule || !matchedRule.skip) {
    return defaultResult;
  }

  // Safety floor: if the user message contains a salient token from
  // recent context, override to RECALL.
  const recentContext = extractRecentContext(messages, SALIENT_CONTEXT_TURNS);
  const contextTokens = extractSalientTokens(recentContext);
  const overlap = findSalientOverlap(trimmed, contextTokens);

  if (overlap.size > 0) {
    return {
      ...defaultResult,
      skip: false,
      rule: matchedRule.rule,
      safetyFloorHit: true,
      safetyFloorTokens: [...overlap],
    };
  }

  return {
    ...defaultResult,
    skip: true,
    rule: matchedRule.rule,
  };
}
