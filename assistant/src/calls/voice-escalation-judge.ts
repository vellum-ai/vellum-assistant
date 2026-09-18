/**
 * Second opinion on the voice front door's escalate decision.
 *
 * The front-door leg is fast and toolless, and it decides in its leading
 * tokens whether a turn needs the tool-capable escalated leg. Its failure mode
 * is answering a turn it cannot complete ("yeah, I'll send that") so nothing
 * ever happens. This judge asks TypeSafe's System One model one yes/no
 * question about the same turn, in parallel with the front-door leg: does a
 * correct reply need something the front door cannot do from here? A
 * confident yes overrules a front-door answer and hands the turn off.
 *
 * The judge runs only when the `voiceEscalationJudge` call site resolves to
 * the TypeSafe provider. Every other outcome (no such profile, provider
 * error, timeout, unparseable answer) is a "clear" verdict, so the front
 * door's own decision stands exactly as it would without the judge.
 */

import type { Message, Provider } from "../providers/types.js";
import { safeStringSlice } from "../util/unicode.js";
import { askTypesafeNoul } from "./typesafe-noul.js";

export const VOICE_ESCALATION_JUDGE_CALL_SITE = "voiceEscalationJudge";

/**
 * Minimum P(yes) that overrules a front-door answer. Calibrated on a labeled
 * set of voice turns: it caught nearly every action request, including bare
 * confirmations of an earlier offer ("yeah, do it"), while clearing ordinary
 * conversation, including follow-ups about work already done.
 */
export const ESCALATION_JUDGE_THRESHOLD = 0.7;

/**
 * Budget from the front-door dispatch. The judge's measured roundtrip sits
 * well under the front-door model's time to first token, so within this
 * budget the verdict is almost always in hand before the first answer word
 * would have been spoken; past it the front door's decision stands.
 */
export const ESCALATION_JUDGE_TIMEOUT_MS = 800;

/** Recent turns shown to the judge, oldest first. */
const HISTORY_TURNS = 6;
const HISTORY_TURN_MAX_CHARS = 600;

export type EscalationJudgeOutcome =
  | "escalate"
  | "clear"
  | "unavailable"
  | "timeout"
  | "error";

export interface EscalationJudgement {
  escalate: boolean;
  outcome: EscalationJudgeOutcome;
  /** Calibrated P(yes), when the judge answered. */
  noul?: number;
  latencyMs: number;
}

const ESCALATION_QUESTION =
  "The voice assistant answering right now has NO tools and no access to the user's accounts, files, messages, calendar, screen, apps, the web, or saved memories. Would a correct reply to what the caller just said require doing something it cannot do from here: taking an action (sending, scheduling, creating, editing, changing, opening, calling), looking up live or current information, or retrieving a personal fact that is not already stated in the recent conversation? Answer yes if the caller is asking for, or agreeing to, any such action, even vaguely or via a short confirmation of an earlier offer. Answer no for conversation, opinions, general knowledge, and questions answerable from the recent conversation.";

function textOf(message: Message): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(
      (text) => text.trim().length > 0 && !text.trimStart().startsWith("<"),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The judge's view of the conversation: the last few spoken turns as plain
 * text, without injected context blocks, tool traffic, or the caller's
 * current utterance (which the judge receives on its own).
 */
export function recentConversationForJudge(
  history: readonly Message[],
  utterance: string,
): string {
  const lines: string[] = [];
  for (const message of history) {
    const text = textOf(message);
    if (text.length === 0) {
      continue;
    }
    const speaker = message.role === "user" ? "caller" : "assistant";
    lines.push(
      `${speaker}: ${safeStringSlice(text, 0, HISTORY_TURN_MAX_CHARS)}`,
    );
  }
  const current = `caller: ${utterance.replace(/\s+/g, " ").trim()}`;
  if (lines.length > 0 && lines[lines.length - 1] === current) {
    lines.pop();
  }
  return lines.slice(-HISTORY_TURNS).join("\n");
}

/**
 * Judge whether a front-door turn must escalate. Never rejects: every failure
 * is a non-escalating verdict, so the front door's decision stands.
 */
export async function judgeEscalation(args: {
  conversationId: string;
  history: readonly Message[];
  utterance: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Provider resolver, injectable for tests. */
  resolveProvider?: () => Promise<Provider | null>;
}): Promise<EscalationJudgement> {
  const utterance = args.utterance.trim();
  if (utterance.length === 0) {
    return { escalate: false, outcome: "unavailable", latencyMs: 0 };
  }
  const result = await askTypesafeNoul({
    callSite: VOICE_ESCALATION_JUDGE_CALL_SITE,
    conversationId: args.conversationId,
    state: {
      recent_conversation:
        recentConversationForJudge(args.history, utterance) ||
        "(start of conversation)",
      caller_just_said: utterance,
    },
    instructions: ESCALATION_QUESTION,
    timeoutMs: args.timeoutMs ?? ESCALATION_JUDGE_TIMEOUT_MS,
    ...(args.signal ? { signal: args.signal } : {}),
    ...(args.resolveProvider ? { resolveProvider: args.resolveProvider } : {}),
  });
  if (result.outcome !== "answered" || result.noul === undefined) {
    return {
      escalate: false,
      outcome: result.outcome === "answered" ? "error" : result.outcome,
      latencyMs: result.latencyMs,
    };
  }
  const escalate = result.noul >= ESCALATION_JUDGE_THRESHOLD;
  return {
    escalate,
    outcome: escalate ? "escalate" : "clear",
    noul: result.noul,
    latencyMs: result.latencyMs,
  };
}
