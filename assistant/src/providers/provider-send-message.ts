/**
 * Helper utilities for provider callsites that should stay decoupled from
 * provider SDK details. Includes provider resolution, timeout utilities,
 * and response extraction helpers.
 */

import { getConfig } from "../config/loader.js";
import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import {
  getProvider,
  initializeProviders,
  listProviders,
} from "./registry.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
  ToolUseContent,
} from "./types.js";

export interface ConfiguredProviderResult {
  provider: Provider;
  configuredProviderName: string;
}

/**
 * Cached promise for the lazy initialization path inside
 * `resolveConfiguredProvider`. When multiple concurrent callers enter before
 * providers are initialized, they all await the same promise instead of
 * each triggering a redundant `initializeProviders` call.
 */
let lazyInitPromise: Promise<void> | null = null;

/**
 * Resolve the configured provider with full selection metadata.
 * If providers haven't been initialized yet (e.g. non-daemon code paths),
 * performs a one-shot `initializeProviders(getConfig())`.
 *
 * When `callSite` is provided, the provider name comes from
 * `resolveCallSiteConfig(callSite, config.llm).provider` — i.e. the unified
 * `llm` block drives selection. Otherwise the legacy
 * `services.inference.provider` is used unchanged.
 *
 * Returns `null` when no providers are available at all.
 */
export async function resolveConfiguredProvider(
  callSite?: LLMCallSite,
): Promise<ConfiguredProviderResult | null> {
  const config = getConfig();

  if (listProviders().length === 0) {
    if (!lazyInitPromise) {
      lazyInitPromise = initializeProviders(config).finally(() => {
        lazyInitPromise = null;
      });
    }
    try {
      await lazyInitPromise;
    } catch {
      return null;
    }
  }

  const inferenceProvider =
    callSite !== undefined
      ? resolveCallSiteConfig(callSite, config.llm).provider
      : config.services.inference.provider;

  try {
    const provider = getProvider(inferenceProvider);
    return {
      provider,
      configuredProviderName: inferenceProvider,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the configured provider through the registry.
 * Thin wrapper around `resolveConfiguredProvider()` for callsites
 * that only need the Provider instance.
 *
 * When `callSite` is provided, resolves the provider via the unified
 * `llm` block (see `resolveConfiguredProvider`). Otherwise preserves the
 * legacy behavior of selecting `services.inference.provider`.
 *
 * Returns `null` when no providers are available.
 */
export async function getConfiguredProvider(
  callSite?: LLMCallSite,
): Promise<Provider | null> {
  const result = await resolveConfiguredProvider(callSite);
  return result?.provider ?? null;
}

/**
 * Create an AbortSignal that fires after `ms` milliseconds.
 * Returns the signal and a cleanup function to clear the timer.
 */
export function createTimeout(ms: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
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
  const block = response.content.find(
    (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
  );
  return block?.text?.trim() ?? "";
}

/**
 * Extract all text blocks from a ProviderResponse and join them.
 */
export function extractAllText(response: ProviderResponse): string {
  const parts = response.content
    .filter(
      (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
    )
    .map((b) => b.text);
  // Join consecutive text blocks with a space, but skip the separator when
  // either side already has whitespace (avoids double-spacing).
  let result = parts[0] ?? "";
  for (let i = 1; i < parts.length; i++) {
    const prev = result[result.length - 1];
    const next = parts[i][0];
    if (
      prev &&
      next &&
      prev !== " " &&
      prev !== "\n" &&
      prev !== "\t" &&
      next !== " " &&
      next !== "\n" &&
      next !== "\t"
    ) {
      result += " ";
    }
    result += parts[i];
  }
  return result;
}

/**
 * Find the first tool_use block in a ProviderResponse.
 */
export function extractToolUse(
  response: ProviderResponse,
): ToolUseContent | undefined {
  return response.content.find(
    (b): b is ToolUseContent => b.type === "tool_use",
  );
}

/**
 * Build a single user message in the provider Message format.
 */
export function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}
