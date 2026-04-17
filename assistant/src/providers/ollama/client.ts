import { getOllamaBaseUrlEnv } from "../../config/env.js";
import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";
// Re-exported so callers that branch on context-overflow can `import` from
// this module without reaching into `../types.js` — the base class' catch
// block converts matching provider errors to ContextOverflowError before
// they reach the caller.
export { ContextOverflowError, isContextOverflowError } from "../types.js";

export interface OllamaProviderOptions {
  apiKey?: string;
  baseURL?: string;
  streamTimeoutMs?: number;
}

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";

export class OllamaProvider extends OpenAIChatCompletionsProvider {
  constructor(model: string, options: OllamaProviderOptions = {}) {
    super(options.apiKey ?? "ollama", model, {
      baseURL: resolveBaseUrl(options.baseURL),
      providerName: "ollama",
      providerLabel: "Ollama",
      streamTimeoutMs: options.streamTimeoutMs,
    });
  }
}

function resolveBaseUrl(optionBaseUrl?: string): string {
  for (const candidate of [optionBaseUrl, getOllamaBaseUrlEnv()]) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return DEFAULT_OLLAMA_BASE_URL;
}
