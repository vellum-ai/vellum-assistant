/**
 * Decides whether a barged-in request should keep running as a background
 * continuation, from what the caller said when they interrupted.
 *
 * A barge-in hands the interrupted turn's work to a background subagent so
 * it is not lost. That is right when the caller moved on to something else
 * ("oh, also, what's the weather?") or only acknowledged it ("okay, thanks"),
 * and wrong when the interruption cancels or changes the request ("actually,
 * just point it out for me"): the continuation then does work the caller
 * no longer wants, while the foreground turn handles the changed request.
 *
 * The judge runs only when the `voiceContinuationJudge` call site resolves to
 * the TypeSafe provider. Without one, the session never waits on it. Every
 * failure keeps the continuation, which is the behavior without a judge.
 */

import {
  askTypesafeNoul,
  resolveTypesafeProvider,
} from "../providers/jev/ask.js";
import type { Provider } from "../providers/types.js";

export const VOICE_CONTINUATION_JUDGE_CALL_SITE = "voiceContinuationJudge";

/**
 * Minimum P(yes) that keeps the continuation. Calibrated on labeled
 * interruptions: cancels, corrections, and repeats scored 0.05 to 0.21;
 * unrelated requests, acknowledgements, and progress questions scored 0.56
 * to 0.89.
 */
export const CONTINUATION_JUDGE_KEEP_THRESHOLD = 0.4;

export const CONTINUATION_JUDGE_TIMEOUT_MS = 1_500;

const KEEP_QUESTION =
  "The voice assistant was working on the caller's earlier request when the caller interrupted it. Should the assistant still finish that earlier request in the background, exactly as originally asked? Answer yes if the caller's new words are unrelated to it (a separate question, request, or remark), an acknowledgement, or a question about its progress. Answer no if the new words cancel it, change the caller's mind about it, correct or change what should be done, ask for it differently, or simply repeat it.";

export type ContinuationJudgeOutcome =
  | "keep"
  | "drop"
  | "unavailable"
  | "no_interruption"
  | "timeout"
  | "error";

export interface ContinuationJudgement {
  keep: boolean;
  outcome: ContinuationJudgeOutcome;
  noul?: number;
  latencyMs: number;
}

/**
 * Judges one barge-in. `interruption` resolves with the caller's interrupting
 * words once the next turn dispatches, or null when none arrived in time;
 * the judge awaits it only when a TypeSafe profile is configured. Never
 * rejects.
 */
export type LiveVoiceContinuationJudge = (args: {
  parentConversationId: string;
  interruptedRequest: string;
  interruption: Promise<string | null>;
  signal: AbortSignal;
}) => Promise<ContinuationJudgement>;

export function createContinuationJudge(options?: {
  /** Provider resolver, injectable for tests. */
  resolveProvider?: () => Promise<Provider | null>;
  timeoutMs?: number;
}): LiveVoiceContinuationJudge {
  const resolveProvider =
    options?.resolveProvider ??
    (() => resolveTypesafeProvider(VOICE_CONTINUATION_JUDGE_CALL_SITE));
  return async (args) => {
    const startedAt = Date.now();
    const kept = (
      outcome: ContinuationJudgeOutcome,
      noul?: number,
    ): ContinuationJudgement => ({
      keep: true,
      outcome,
      ...(noul !== undefined ? { noul } : {}),
      latencyMs: Date.now() - startedAt,
    });
    let provider: Provider | null;
    try {
      provider = await resolveProvider();
    } catch {
      return kept("error");
    }
    if (!provider || args.interruptedRequest.trim().length === 0) {
      return kept("unavailable");
    }
    const interruption = (await args.interruption)?.trim() ?? "";
    if (interruption.length === 0) {
      return kept("no_interruption");
    }
    const result = await askTypesafeNoul({
      callSite: VOICE_CONTINUATION_JUDGE_CALL_SITE,
      conversationId: args.parentConversationId,
      state: {
        interrupted_request: args.interruptedRequest.trim(),
        caller_then_said: interruption,
      },
      instructions: KEEP_QUESTION,
      timeoutMs: options?.timeoutMs ?? CONTINUATION_JUDGE_TIMEOUT_MS,
      signal: args.signal,
      resolveProvider: async () => provider,
    });
    if (result.outcome !== "answered" || result.noul === undefined) {
      return kept(result.outcome === "answered" ? "error" : result.outcome);
    }
    if (result.noul >= CONTINUATION_JUDGE_KEEP_THRESHOLD) {
      return kept("keep", result.noul);
    }
    return {
      keep: false,
      outcome: "drop",
      noul: result.noul,
      latencyMs: Date.now() - startedAt,
    };
  };
}
