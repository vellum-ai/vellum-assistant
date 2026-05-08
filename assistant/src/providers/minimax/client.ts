import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";

export interface MiniMaxProviderOptions {
  apiKey?: string;
  baseURL?: string;
  streamTimeoutMs?: number;
}

/**
 * MiniMax exposes an OpenAI-compatible chat-completions API. International
 * traffic uses `api.minimax.io`; mainland China traffic uses `api.minimaxi.com`.
 * Override via `baseURL` (or workspace config / `MINIMAX_BASE_URL` if exposed
 * later) when targeting the China endpoint.
 *
 * Reasoning effort is capped at "high" because MiniMax-M1/M2 documents only the
 * `low|medium|high` tiers; sending `xhigh`/`max` would 4xx upstream — same
 * compatibility constraint as Fireworks.
 */
const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/v1";

export class MiniMaxProvider extends OpenAIChatCompletionsProvider {
  constructor(
    apiKey: string,
    model: string,
    options: MiniMaxProviderOptions = {},
  ) {
    super(apiKey, model, {
      baseURL: options.baseURL?.trim() || DEFAULT_MINIMAX_BASE_URL,
      providerName: "minimax",
      providerLabel: "MiniMax",
      streamTimeoutMs: options.streamTimeoutMs,
      maxReasoningEffort: "high",
    });
  }
}
