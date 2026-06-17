/**
 * Run one advisor consult.
 *
 * Routed entirely through Vellum's own inference: `getConfiguredProvider`
 * resolves the `advisor` call site to a provider/model/credentials from the
 * configured profiles (managed-proxy or BYOK alike — no separate API key), and
 * `runBtwSidechain` runs an ephemeral, non-persisted completion with tools
 * forced off. The advisor therefore sees the executor's transcript and system
 * prompt, runs tool-less, and returns plain guidance text — mirroring the
 * advisor tool's sub-inference.
 */

import { getConfiguredProvider } from "../../../providers/provider-send-message.js";
import type { Message } from "../../../providers/types.js";
import { runBtwSidechain } from "../../../runtime/btw-sidechain.js";
import { ADVISOR_CONFIG } from "./config.js";
import { advisorRequestText, buildAdvisorSystem } from "./steering.js";
import { toAdvisorMessages } from "./transcript.js";

/** The dedicated call site whose configured profile selects the advisor model. */
const ADVISOR_CALL_SITE = "advisor" as const;

export interface ConsultParams {
  systemPrompt: string | null;
  messages: ReadonlyArray<Message>;
  signal?: AbortSignal;
}

/**
 * Returns the advisor's guidance text, or a short benign notice when the
 * advisor can't run. Callers should surface the string as a non-error tool
 * result so the executor continues regardless — matching the advisor tool's
 * "the executor sees the error and continues; the request does not fail."
 */
export async function consultAdvisor(params: ConsultParams): Promise<string> {
  const messages = toAdvisorMessages(params.messages);
  if (messages.length === 0) {
    return "(advisor: no conversation context is available yet)";
  }

  const provider = await getConfiguredProvider(ADVISOR_CALL_SITE);
  if (!provider) {
    return "(advisor unavailable: no inference provider is configured)";
  }

  const { text } = await runBtwSidechain({
    provider,
    messages,
    content: advisorRequestText(ADVISOR_CONFIG.wordLimit),
    systemPrompt: buildAdvisorSystem(params.systemPrompt),
    callSite: ADVISOR_CALL_SITE,
    tools: [],
    maxTokens: ADVISOR_CONFIG.maxTokens,
    timeoutMs: ADVISOR_CONFIG.timeoutMs,
    signal: params.signal,
  });

  const advice = text.trim();
  return advice.length > 0 ? advice : "(advisor returned no guidance)";
}
