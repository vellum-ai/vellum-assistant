/**
 * Helper utilities for provider callsites that should stay decoupled from
 * provider SDK details. Includes provider resolution, timeout utilities,
 * and response extraction helpers.
 */

import type { Provider, ProviderResponse, Message, ContentBlock, ToolUseContent } from './types.js';
import { getFailoverProvider, getProvider, listProviders, initializeProviders } from './registry.js';
import { getConfig } from '../config/loader.js';

/**
 * Resolve the configured provider through the registry/failover path.
 * If providers haven't been initialized yet (e.g. non-daemon code paths),
 * performs a one-shot `initializeProviders(getConfig())`.
 *
 * Returns `null` when the configured provider is unavailable.
 */
export function getConfiguredProvider(): Provider | null {
  const config = getConfig();

  if (listProviders().length === 0) {
    try {
      initializeProviders(config);
    } catch {
      return null;
    }
  }

  if (!listProviders().includes(config.provider)) {
    return null;
  }

  try {
    const providerOrder = Array.isArray(config.providerOrder) ? config.providerOrder : [];
    return getFailoverProvider(config.provider, providerOrder);
  } catch {
    return null;
  }
}

/**
 * Legacy Anthropic-only resolver kept for compatibility while callsites
 * migrate to `getConfiguredProvider`.
 */
export function getAnthropicProvider(): Provider | null {
  if (listProviders().length === 0) {
    try {
      initializeProviders(getConfig());
    } catch {
      return null;
    }
  }

  try {
    return getProvider('anthropic');
  } catch {
    return null;
  }
}

/**
 * Create an AbortSignal that fires after `ms` milliseconds.
 * Returns the signal and a cleanup function to clear the timer.
 */
export function createTimeout(ms: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

/**
 * Extract the first text block's text from a ProviderResponse.
 * Returns empty string if no text block is found.
 */
export function extractText(response: ProviderResponse): string {
  const block = response.content.find((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text');
  return block?.text?.trim() ?? '';
}

/**
 * Extract all text blocks from a ProviderResponse and join them.
 */
export function extractAllText(response: ProviderResponse): string {
  return response.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * Find the first tool_use block in a ProviderResponse.
 */
export function extractToolUse(response: ProviderResponse): ToolUseContent | undefined {
  return response.content.find((b): b is ToolUseContent => b.type === 'tool_use');
}

/**
 * Build a single user message in the provider Message format.
 */
export function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/**
 * Build a single user message with image + text content.
 */
export function userMessageWithImage(
  imageBase64: string,
  mediaType: string,
  text: string,
): Message {
  return {
    role: 'user',
    content: [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: imageBase64,
        },
      },
      { type: 'text', text },
    ],
  };
}

/**
 * Build a single user message with multiple images followed by a text block.
 * Each image becomes its own content block; the text block comes last.
 */
export function userMessageWithImages(
  images: Array<{ base64: string; mediaType: string }>,
  text: string,
): Message {
  return {
    role: 'user',
    content: [
      ...images.map((img) => ({
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: img.mediaType,
          data: img.base64,
        },
      })),
      { type: 'text' as const, text },
    ],
  };
}
