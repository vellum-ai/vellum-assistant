/**
 * Helper utilities for provider callsites that should stay decoupled from
 * provider SDK details. Includes provider resolution, timeout utilities,
 * and response extraction helpers.
 */

import { getConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import {
  getFailoverProvider,
  initializeProviders,
  listProviders,
  resolveProviderSelection,
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
  selectedProviderName: string;
  usedFallbackPrimary: boolean;
}

const providerSelectionLog = getLogger("provider-selection");
let fallbackWarningLogged = false;

/**
 * Resolve the configured provider with full selection metadata.
 * If providers haven't been initialized yet (e.g. non-daemon code paths),
 * performs a one-shot `initializeProviders(getConfig())`.
 *
 * Uses fail-open selection: if the configured provider is unavailable but
 * alternates from `config.providerOrder` exist, selects the first available.
 *
 * Returns `null` when no providers are available at all.
 */
export async function resolveConfiguredProvider(): Promise<ConfiguredProviderResult | null> {
  const config = getConfig();

  if (listProviders().length === 0) {
    try {
      await initializeProviders(config);
    } catch {
      return null;
    }
  }

  const providerOrder = Array.isArray(config.providerOrder)
    ? config.providerOrder
    : [];
  const inferenceProvider = config.services.inference.provider;
  const selection = resolveProviderSelection(inferenceProvider, providerOrder);

  if (!selection.selectedPrimary) {
    return null;
  }

  if (selection.usedFallbackPrimary) {
    const level = fallbackWarningLogged ? "debug" : "warn";
    providerSelectionLog[level](
      { configured: inferenceProvider, selected: selection.selectedPrimary },
      "Configured provider unavailable, using fallback",
    );
    fallbackWarningLogged = true;
  }

  try {
    const provider = getFailoverProvider(inferenceProvider, providerOrder);
    return {
      provider,
      configuredProviderName: inferenceProvider,
      selectedProviderName: selection.selectedPrimary,
      usedFallbackPrimary: selection.usedFallbackPrimary,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the configured provider through the registry/failover path.
 * Thin wrapper around `resolveConfiguredProvider()` for callsites
 * that only need the Provider instance.
 *
 * Returns `null` when no providers are available.
 */
export async function getConfiguredProvider(): Promise<Provider | null> {
  const result = await resolveConfiguredProvider();
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
