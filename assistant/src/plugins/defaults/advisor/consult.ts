/**
 * Run one advisor consult.
 *
 * Routed entirely through the assistant's own inference: `getConfiguredProvider`
 * resolves the general-purpose `inference` call site (with the advisor profile
 * applied as an `overrideProfile`) to a provider/model/credentials from the
 * configured profiles — managed-proxy or BYOK, no separate API key. The consult
 * then runs a tool-less, capped one-shot completion through `provider.sendMessage`
 * and returns the text.
 */

import type { LLMCallSite } from "../../../config/schemas/llm.js";
import {
  extractAllText,
  getConfiguredProvider,
  userMessage,
} from "../../../providers/provider-send-message.js";
import type { Message } from "../../../providers/types.js";
import { ADVISOR_CONFIG } from "./config.js";
import { advisorRequestText, buildAdvisorSystem } from "./steering.js";
import { toAdvisorMessages } from "./transcript.js";

// The general-purpose call site; the model is selected via `overrideProfile`.
const ADVISOR_CALL_SITE: LLMCallSite = "inference";

export interface ConsultParams {
  systemPrompt: string | null;
  messages: ReadonlyArray<Message>;
  signal?: AbortSignal;
}

/** Combine the caller's signal with a consult timeout. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Returns the advisor's guidance text, or a short benign notice when the
 * advisor can't run. Callers should surface the string as a non-error tool
 * result so the executor continues regardless.
 */
export async function consultAdvisor(params: ConsultParams): Promise<string> {
  const history = toAdvisorMessages(params.messages);
  if (history.length === 0) {
    return "(advisor: no conversation context is available yet)";
  }

  const provider = await getConfiguredProvider(ADVISOR_CALL_SITE, {
    overrideProfile: ADVISOR_CONFIG.profile,
  });
  if (!provider) {
    return "(advisor unavailable: no inference provider is configured)";
  }

  // Append the consult instruction as the final user turn, then run a
  // tool-less, capped completion through the resolved provider.
  const messages: Message[] = [
    ...history,
    userMessage(advisorRequestText(ADVISOR_CONFIG.wordLimit)),
  ];

  const response = await provider.sendMessage(messages, {
    systemPrompt: buildAdvisorSystem(params.systemPrompt),
    config: {
      callSite: ADVISOR_CALL_SITE,
      overrideProfile: ADVISOR_CONFIG.profile,
      tool_choice: { type: "none" },
      max_tokens: ADVISOR_CONFIG.maxTokens,
    },
    signal: withTimeout(params.signal, ADVISOR_CONFIG.timeoutMs),
  });

  const advice = extractAllText(response).trim();
  return advice.length > 0 ? advice : "(advisor returned no guidance)";
}
