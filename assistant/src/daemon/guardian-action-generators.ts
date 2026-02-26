import { loadConfig } from '../config/loader.js';
import { getFailoverProvider } from '../providers/registry.js';
import {
  buildGuardianActionGenerationPrompt,
  getGuardianActionFallbackMessage,
  GUARDIAN_ACTION_COPY_MAX_TOKENS,
  GUARDIAN_ACTION_COPY_SYSTEM_PROMPT,
  GUARDIAN_ACTION_COPY_TIMEOUT_MS,
  includesRequiredKeywords,
} from '../runtime/guardian-action-message-composer.js';
import type { GuardianActionCopyGenerator } from '../runtime/http-types.js';

/**
 * Create the daemon-owned guardian action copy generator that resolves
 * providers and calls `provider.sendMessage` to generate guardian action
 * copy text. Uses `latency-optimized` model intent since these are
 * time-sensitive voice responses.
 *
 * This keeps all provider awareness in the daemon lifecycle, away from
 * the runtime composer.
 */
export function createGuardianActionCopyGenerator(): GuardianActionCopyGenerator {
  return async (context, options = {}) => {
    const config = loadConfig();
    let provider;
    try {
      provider = getFailoverProvider(config.provider, config.providerOrder);
    } catch {
      return null;
    }

    const fallbackText = options.fallbackText?.trim() || getGuardianActionFallbackMessage(context);
    const requiredKeywords = options.requiredKeywords?.map((kw) => kw.trim()).filter((kw) => kw.length > 0);
    const prompt = buildGuardianActionGenerationPrompt(context, fallbackText, requiredKeywords);

    const response = await provider.sendMessage(
      [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      [],
      GUARDIAN_ACTION_COPY_SYSTEM_PROMPT,
      {
        config: {
          max_tokens: options.maxTokens ?? GUARDIAN_ACTION_COPY_MAX_TOKENS,
          modelIntent: 'latency-optimized',
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? GUARDIAN_ACTION_COPY_TIMEOUT_MS),
      },
    );

    const block = response.content.find((entry) => entry.type === 'text');
    const text = block && 'text' in block ? block.text.trim() : '';
    if (!text) return null;
    const cleaned = text
      .replace(/^["'`]+/, '')
      .replace(/["'`]+$/, '')
      .trim();
    if (!cleaned) return null;
    if (!includesRequiredKeywords(cleaned, requiredKeywords)) return null;
    return cleaned;
  };
}
