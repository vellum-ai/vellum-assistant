import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";

export interface HostedProviderOptions {
  apiKey?: string;
  baseURL?: string;
  streamTimeoutMs?: number;
}

/**
 * OpenAI-compatible client for Vellum-hosted GPU inference (vLLM).
 * Managed requests set `baseURL` to the platform `/v1/runtime-proxy/vellum`
 * path; the platform forwards to the online node's vLLM server.
 */
export class HostedProvider extends OpenAIChatCompletionsProvider {
  constructor(
    apiKey: string,
    model: string,
    options: HostedProviderOptions = {},
  ) {
    super(apiKey || "not-needed", model, {
      providerName: "hosted",
      providerLabel: "Vellum Hosted",
      streamTimeoutMs: options.streamTimeoutMs,
      omitToolChoiceWhenReasoning: true,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }
}
