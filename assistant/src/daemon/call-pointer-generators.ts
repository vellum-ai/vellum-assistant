import { loadConfig } from '../config/loader.js';
import { getFailoverProvider } from '../providers/registry.js';
import {
  POINTER_COPY_MAX_TOKENS,
  POINTER_COPY_SYSTEM_PROMPT,
  POINTER_COPY_TIMEOUT_MS,
  buildPointerGenerationPrompt,
  getPointerFallbackMessage,
  includesRequiredFacts,
} from '../calls/call-pointer-message-composer.js';
import type { PointerCopyGenerator } from '../runtime/http-types.js';

/**
 * Create the daemon-owned pointer copy generator that resolves providers
 * and calls `provider.sendMessage` to generate pointer message text.
 * This keeps all provider awareness in the daemon lifecycle, away from
 * the runtime composer.
 */
export function createPointerCopyGenerator(): PointerCopyGenerator {
  return async (context, options = {}) => {
    const config = loadConfig();
    let provider;
    try {
      provider = getFailoverProvider(config.provider, config.providerOrder);
    } catch {
      return null;
    }

    const fallbackText = options.fallbackText?.trim() || getPointerFallbackMessage(context);
    const requiredFacts = options.requiredFacts
      ?.map((f) => f.trim())
      .filter((f) => f.length > 0);
    const prompt = buildPointerGenerationPrompt(context, fallbackText, requiredFacts);

    const response = await provider.sendMessage(
      [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      [],
      POINTER_COPY_SYSTEM_PROMPT,
      {
        config: {
          max_tokens: options.maxTokens ?? POINTER_COPY_MAX_TOKENS,
          modelIntent: 'latency-optimized',
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? POINTER_COPY_TIMEOUT_MS),
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
    if (!includesRequiredFacts(cleaned, requiredFacts)) return null;
    return cleaned;
  };
}
