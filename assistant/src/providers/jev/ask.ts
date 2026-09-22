/**
 * One bounded question set to TypeSafe's System One model (Jev), shared by
 * the voice judges and the automatic profile router. A caller runs its
 * question only when its call site resolves to the TypeSafe provider; every
 * failure comes back as a non-answer so the caller keeps its default
 * behavior.
 */

import type { LLMCallSite } from "../../config/schemas/llm.js";
import { getLogger } from "../../util/logger.js";
import { resolveConfiguredProvider } from "../provider-send-message.js";
import type { Provider, ProviderResponse } from "../types.js";
import {
  type JevJsonValue,
  type JevQuestions,
  noulFromAnswer,
} from "./client.js";

const log = getLogger("typesafe-ask");

const TYPESAFE_PROVIDER_NAME = "typesafe";

export type TypesafeOutcome = "answered" | "unavailable" | "timeout" | "error";

export interface TypesafeAskResult {
  outcome: TypesafeOutcome;
  /** One entry per question id, present when the outcome is "answered". */
  answers?: Record<string, unknown>;
  latencyMs: number;
}

export interface TypesafeNoulResult {
  outcome: TypesafeOutcome;
  /** Calibrated P(yes), present when the outcome is "answered". */
  noul?: number;
  latencyMs: number;
}

/**
 * The call site's provider when it resolves to TypeSafe, else null. Judged
 * on the dispatched adapter's name rather than the configured provider: a
 * managed profile is configured as `vellum` and only substitutes the
 * TypeSafe upstream at dispatch, so the configured name alone would report
 * the managed Jev profile as unavailable.
 */
export async function resolveTypesafeProvider(
  callSite: LLMCallSite,
): Promise<Provider | null> {
  const resolved = await resolveConfiguredProvider(callSite);
  return resolved?.provider.name === TYPESAFE_PROVIDER_NAME
    ? resolved.provider
    : null;
}

function answersFrom(
  response: ProviderResponse,
): Record<string, unknown> | null {
  const raw = response.rawResponse;
  if (
    typeof raw === "object" &&
    raw !== null &&
    "answers" in raw &&
    typeof raw.answers === "object" &&
    raw.answers !== null
  ) {
    return raw.answers as Record<string, unknown>;
  }
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(block.text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface TypesafeAskArgs {
  callSite: LLMCallSite;
  conversationId: string;
  state: JevJsonValue;
  questions: JevQuestions;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Defaults to {@link resolveTypesafeProvider} for `callSite`. */
  resolveProvider?: () => Promise<Provider | null>;
}

/**
 * Ask one question set. Never rejects. The timeout is a hard race rather
 * than trust in the provider honoring the abort, because callers hold user
 * audio or a turn's first token on the answer.
 */
export async function askTypesafe(
  args: TypesafeAskArgs,
): Promise<TypesafeAskResult> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const controller = new AbortController();
  const signal = args.signal
    ? AbortSignal.any([args.signal, controller.signal])
    : controller.signal;

  const ask = async (): Promise<TypesafeAskResult> => {
    try {
      const provider = await (
        args.resolveProvider ?? (() => resolveTypesafeProvider(args.callSite))
      )();
      if (!provider) {
        return { outcome: "unavailable", latencyMs: elapsed() };
      }
      const response = await provider.sendMessage(
        [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  state: args.state,
                  questions: args.questions,
                }),
              },
            ],
          },
        ],
        {
          config: {
            callSite: args.callSite,
            conversationId: args.conversationId,
            disableTurnStartCache: true,
          },
          signal,
        },
      );
      const answers = answersFrom(response);
      if (answers === null) {
        log.warn(
          { callSite: args.callSite, conversationId: args.conversationId },
          "TypeSafe returned no usable answers",
        );
        return { outcome: "error", latencyMs: elapsed() };
      }
      return { outcome: "answered", answers, latencyMs: elapsed() };
    } catch (err) {
      if (!signal.aborted) {
        log.warn(
          { err, callSite: args.callSite, conversationId: args.conversationId },
          "TypeSafe question failed",
        );
      }
      return { outcome: "error", latencyMs: elapsed() };
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<TypesafeAskResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ outcome: "timeout", latencyMs: elapsed() });
    }, args.timeoutMs);
  });
  try {
    return await Promise.race([ask(), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Ask one yes/no question. Never rejects. */
export async function askTypesafeNoul(
  args: Omit<TypesafeAskArgs, "questions"> & { instructions: string },
): Promise<TypesafeNoulResult> {
  const { instructions, ...rest } = args;
  const result = await askTypesafe({
    ...rest,
    questions: { answer: { type: "noul", instructions } },
  });
  if (result.outcome !== "answered") {
    return { outcome: result.outcome, latencyMs: result.latencyMs };
  }
  const noul = noulFromAnswer(result.answers?.answer);
  if (noul === undefined) {
    log.warn(
      { callSite: args.callSite, conversationId: args.conversationId },
      "TypeSafe judge returned no usable answer",
    );
    return { outcome: "error", latencyMs: result.latencyMs };
  }
  return { outcome: "answered", noul, latencyMs: result.latencyMs };
}
