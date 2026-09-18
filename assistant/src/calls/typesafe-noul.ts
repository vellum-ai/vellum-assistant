/**
 * One bounded yes/no question to TypeSafe's System One model (Jev), shared by
 * the voice judges. A judge runs only when its call site resolves to the
 * TypeSafe provider; every failure comes back as a non-answer so the caller
 * keeps its default behavior.
 */

import type { LLMCallSite } from "../config/schemas/llm.js";
import { type JevJsonValue, noulFromAnswer } from "../providers/jev/client.js";
import { resolveConfiguredProvider } from "../providers/provider-send-message.js";
import type { Provider, ProviderResponse } from "../providers/types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("typesafe-noul");

const TYPESAFE_PROVIDER_NAME = "typesafe";

export type TypesafeNoulOutcome =
  | "answered"
  | "unavailable"
  | "timeout"
  | "error";

export interface TypesafeNoulResult {
  outcome: TypesafeNoulOutcome;
  /** Calibrated P(yes), present when the outcome is "answered". */
  noul?: number;
  latencyMs: number;
}

/** The call site's provider when it resolves to TypeSafe, else null. */
export async function resolveTypesafeProvider(
  callSite: LLMCallSite,
): Promise<Provider | null> {
  const resolved = await resolveConfiguredProvider(callSite);
  return resolved?.configuredProviderName === TYPESAFE_PROVIDER_NAME
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

/**
 * Ask one noul question. Never rejects. The timeout is a hard race rather
 * than trust in the provider honoring the abort, because callers hold user
 * audio or background work on the answer.
 */
export async function askTypesafeNoul(args: {
  callSite: LLMCallSite;
  conversationId: string;
  state: JevJsonValue;
  instructions: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Defaults to {@link resolveTypesafeProvider} for `callSite`. */
  resolveProvider?: () => Promise<Provider | null>;
}): Promise<TypesafeNoulResult> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const controller = new AbortController();
  const signal = args.signal
    ? AbortSignal.any([args.signal, controller.signal])
    : controller.signal;

  const ask = async (): Promise<TypesafeNoulResult> => {
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
                  questions: {
                    answer: { type: "noul", instructions: args.instructions },
                  },
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
      const noul = noulFromAnswer(answersFrom(response)?.answer);
      if (noul === undefined) {
        log.warn(
          { callSite: args.callSite, conversationId: args.conversationId },
          "TypeSafe judge returned no usable answer",
        );
        return { outcome: "error", latencyMs: elapsed() };
      }
      return { outcome: "answered", noul, latencyMs: elapsed() };
    } catch (err) {
      if (!signal.aborted) {
        log.warn(
          { err, callSite: args.callSite, conversationId: args.conversationId },
          "TypeSafe judge failed",
        );
      }
      return { outcome: "error", latencyMs: elapsed() };
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<TypesafeNoulResult>((resolve) => {
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
