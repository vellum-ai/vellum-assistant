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

import { getConfig } from "../../../config/loader.js";
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

// Dedicated advisor call site. Its default profile (`frontier`) lives in
// CALL_SITE_DEFAULTS; a workspace overrides which profile the advisor runs on
// via `llm.advisorProfile`, which we float above the call-site layers.
const ADVISOR_CALL_SITE: LLMCallSite = "advisor";

/**
 * Resolve the routing override for the advisor consult. When the workspace has
 * set `llm.advisorProfile`, force it above the call-site layers so it is
 * authoritative; otherwise return `{}` so the `advisor` call site resolves to
 * its default profile.
 */
function advisorOverride(): {
  overrideProfile?: string;
  forceOverrideProfile?: boolean;
} {
  const advisorProfile = getConfig().llm.advisorProfile;
  return advisorProfile
    ? { overrideProfile: advisorProfile, forceOverrideProfile: true }
    : {};
}

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

  const override = advisorOverride();

  const provider = await getConfiguredProvider(ADVISOR_CALL_SITE, override);
  if (!provider) {
    return "(advisor unavailable: no inference provider is configured)";
  }

  // Append the consult instruction as the final user turn, then run a
  // tool-less completion through the resolved provider. No `max_tokens` is
  // set, so the resolver applies the profile's normal output budget rather
  // than an advisor-specific cap.
  const messages: Message[] = [...history, userMessage(advisorRequestText())];

  const response = await provider.sendMessage(messages, {
    systemPrompt: buildAdvisorSystem(params.systemPrompt),
    config: {
      callSite: ADVISOR_CALL_SITE,
      ...override,
      tool_choice: { type: "none" },
    },
    signal: withTimeout(params.signal, ADVISOR_CONFIG.timeoutMs),
  });

  const advice = extractAllText(response).trim();
  return advice.length > 0 ? advice : "(advisor returned no guidance)";
}
