import { runOneShotLLM } from "../providers/one-shot-llm.js";
import {
  buildGuardianActionGenerationPrompt,
  getGuardianActionFallbackMessage,
  GUARDIAN_ACTION_COPY_SYSTEM_PROMPT,
  GUARDIAN_ACTION_COPY_TIMEOUT_MS,
  includesRequiredKeywords,
} from "../runtime/guardian-action-message-composer.js";
import type { GuardianActionCopyGenerator } from "../runtime/http-types.js";

/**
 * Create the daemon-owned guardian action copy generator that resolves a
 * provider and runs a one-shot LLM call to generate guardian action copy
 * text. Uses the `guardianQuestionCopy` call site so model selection,
 * provider/connection routing, and tuning all track the unified
 * `llm.callSites` configuration.
 *
 * This keeps all provider awareness in the daemon lifecycle, away from
 * the runtime composer.
 */
export function createGuardianActionCopyGenerator(): GuardianActionCopyGenerator {
  return async (context, options = {}) => {
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

    const result = await runOneShotLLM(
      "guardianQuestionCopy",
      [{ role: "user", content: [{ type: "text", text: prompt }] }],
      {
        systemPrompt: GUARDIAN_ACTION_COPY_SYSTEM_PROMPT,
        timeoutMs: options.timeoutMs ?? GUARDIAN_ACTION_COPY_TIMEOUT_MS,
        // No provider configured → unavailable; any non-`ok` status below
        // returns null so the caller falls back to deterministic template copy.
        onUnavailable: "null",
        // Runtime per-call override only. When `options.maxTokens` is
        // undefined the resolved CALL_SITE_DEFAULTS.guardianQuestionCopy cap
        // (200) auto-flows to the wire via retry.ts — do not hardcode it here.
        ...(options.maxTokens !== undefined
          ? // call-site-tuning:allow — reason: runtime caller override, not a static default
            { config: { max_tokens: options.maxTokens } }
          : {}),
      },
    );

    if (result.status !== "ok") return null;
    const cleaned = result.data
      .replace(/^["'`]+/, "")
      .replace(/["'`]+$/, "")
      .trim();
    if (!cleaned) return null;
    if (!includesRequiredKeywords(cleaned, requiredKeywords)) return null;
    return cleaned;
  };
}
