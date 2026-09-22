/**
 * Shadow-mode judge for whether a spoken utterance was addressed to the
 * assistant at all.
 *
 * Live voice has no wake word and no speaker labels, so every utterance the
 * microphone catches becomes a turn: a caller who turns away to talk to
 * someone in the room still gets an answer. The transcript carries both
 * sides as if the caller said them, so the judgement is content-only.
 *
 * This judge only observes. Its verdict is logged beside the turn it would
 * have suppressed and nothing acts on it, because the number that decides
 * whether a gate is shippable is how often it would wrongly ignore a real
 * request (JARVIS-1835). A wrong ignore is silence with no recovery, so a
 * gate would need a threshold biased toward answering.
 *
 * The judge runs only when the `voiceAddressivityJudge` call site resolves
 * to the TypeSafe provider. Every failure is an "unavailable" verdict that
 * logs nothing an analysis would mistake for a decision.
 */

import type { Message, Provider } from "../providers/types.js";
import { askTypesafeNoul } from "./typesafe-noul.js";
import { recentConversationForJudge } from "./voice-escalation-judge.js";

export const VOICE_ADDRESSIVITY_JUDGE_CALL_SITE = "voiceAddressivityJudge";

/**
 * The P(yes) a gate would need to clear to answer. Not yet calibrated: it
 * exists so the shadow logs carry the verdict a gate would have reached.
 * Shadow data on real sessions sets the shipped value.
 */
export const ADDRESSIVITY_JUDGE_ANSWER_THRESHOLD = 0.3;

/**
 * Shadow mode never holds audio, so the budget only bounds how long the
 * observation runs before it is abandoned.
 */
export const ADDRESSIVITY_JUDGE_TIMEOUT_MS = 1_500;

const ADDRESSED_QUESTION =
  "This is a live voice call between a caller and an assistant. The microphone also picks up the caller talking to other people nearby, and those words arrive in the transcript as if they were spoken to the assistant. Was what the caller just said addressed to the assistant? Answer yes if it is a request, question, instruction, correction, or reply meant for the assistant, including a short acknowledgement of what the assistant just said. Answer no if the caller is speaking to someone else in the room, talking to themselves, or the words are stray speech the assistant was never meant to act on.";

export type AddressivityJudgeOutcome =
  | "addressed"
  | "not_addressed"
  | "unavailable"
  | "timeout"
  | "error";

export interface AddressivityJudgement {
  /** What a gate at {@link ADDRESSIVITY_JUDGE_ANSWER_THRESHOLD} would do. */
  addressed: boolean;
  outcome: AddressivityJudgeOutcome;
  /** Calibrated P(yes), when the judge answered. */
  noul?: number;
  latencyMs: number;
}

/**
 * Judge one utterance. Never rejects, and never affects the turn: the caller
 * of this function logs the verdict and carries on.
 */
export async function judgeAddressivity(args: {
  conversationId: string;
  history: readonly Message[];
  utterance: string;
  /** True when this utterance interrupted the assistant mid-speech. */
  bargeIn: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Provider resolver, injectable for tests. */
  resolveProvider?: () => Promise<Provider | null>;
}): Promise<AddressivityJudgement> {
  const utterance = args.utterance.trim();
  if (utterance.length === 0) {
    return { addressed: true, outcome: "unavailable", latencyMs: 0 };
  }
  const result = await askTypesafeNoul({
    callSite: VOICE_ADDRESSIVITY_JUDGE_CALL_SITE,
    conversationId: args.conversationId,
    state: {
      recent_conversation:
        recentConversationForJudge(args.history, utterance) ||
        "(start of conversation)",
      caller_just_said: utterance,
      // The assistant talking is what makes an aside look like a barge-in,
      // so the judge sees which of the two situations it is in.
      assistant_was_speaking: args.bargeIn,
    },
    instructions: ADDRESSED_QUESTION,
    timeoutMs: args.timeoutMs ?? ADDRESSIVITY_JUDGE_TIMEOUT_MS,
    ...(args.signal ? { signal: args.signal } : {}),
    ...(args.resolveProvider ? { resolveProvider: args.resolveProvider } : {}),
  });
  if (result.outcome !== "answered" || result.noul === undefined) {
    return {
      addressed: true,
      outcome: result.outcome === "answered" ? "error" : result.outcome,
      latencyMs: result.latencyMs,
    };
  }
  const addressed = result.noul >= ADDRESSIVITY_JUDGE_ANSWER_THRESHOLD;
  return {
    addressed,
    outcome: addressed ? "addressed" : "not_addressed",
    noul: result.noul,
    latencyMs: result.latencyMs,
  };
}
