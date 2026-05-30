import { loadConfig } from "../config/loader.js";
import { wrapWithCallSiteRouting } from "../providers/call-site-routing.js";
import { getConfiguredProvider } from "../providers/provider-send-message.js";
import {
  buildGuardianActionGenerationPrompt,
  getGuardianActionFallbackMessage,
  GUARDIAN_ACTION_COPY_MAX_TOKENS,
  GUARDIAN_ACTION_COPY_SYSTEM_PROMPT,
  GUARDIAN_ACTION_COPY_TIMEOUT_MS,
  includesRequiredKeywords,
} from "../runtime/guardian-action-message-composer.js";
import type { GuardianActionCopyGenerator } from "../runtime/http-types.js";

/**
 * Create the daemon-owned guardian action copy generator that resolves
 * providers and calls `provider.sendMessage` to generate guardian action
 * copy text. Uses the `guardianQuestionCopy` call site so model selection
 * tracks the unified `llm.callSites` configuration.
 *
 * This keeps all provider awareness in the daemon lifecycle, away from
 * the runtime composer.
 */
export function createGuardianActionCopyGenerator(): GuardianActionCopyGenerator {
  return async (context, options = {}) => {
    const baseProvider = await getConfiguredProvider("guardianQuestionCopy");
    if (!baseProvider) return null;
    // Wrap so the per-call `callSite` can route to a different provider
    // transport when `llm.callSites.guardianQuestionCopy.provider` overrides
    // the default. Connection-aware: when the resolved profile names a
    // `provider_connection`, that connection's auth wins over the legacy
    // registry lookup. See `wrapWithCallSiteRouting`.
    const provider = wrapWithCallSiteRouting(baseProvider, loadConfig());

    const fallbackText =
      options.fallbackText?.trim() || getGuardianActionFallbackMessage(context);
    const requiredKeywords = options.requiredKeywords
      ?.map((kw) => kw.trim())
      .filter((kw) => kw.length > 0);
    const prompt = buildGuardianActionGenerationPrompt(
      context,
      fallbackText,
      requiredKeywords,
    );

    const response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: prompt }] }],
      {
        tools: [],
        systemPrompt: GUARDIAN_ACTION_COPY_SYSTEM_PROMPT,
        config: {
          max_tokens: options.maxTokens ?? GUARDIAN_ACTION_COPY_MAX_TOKENS,
          callSite: "guardianQuestionCopy",
        },
        signal: AbortSignal.timeout(
          options.timeoutMs ?? GUARDIAN_ACTION_COPY_TIMEOUT_MS,
        ),
      },
    );

    const block = response.content.find((entry) => entry.type === "text");
    const text = block && "text" in block ? block.text.trim() : "";
    if (!text) return null;
    const cleaned = text
      .replace(/^["'`]+/, "")
      .replace(/["'`]+$/, "")
      .trim();
    if (!cleaned) return null;
    if (!includesRequiredKeywords(cleaned, requiredKeywords)) return null;
    return cleaned;
  };
}
