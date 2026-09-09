import { getWorkspaceDir } from "../../util/platform.js";
import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";
import type { SendMessageOptions } from "../types.js";
import { hostedDirectionsExtraBody } from "./personality-directions.js";

export interface VellumProviderOptions {
  apiKey?: string;
  baseURL?: string;
  streamTimeoutMs?: number;
}

/**
 * OpenAI-compatible client for Vellum-hosted GPU inference.
 * Managed requests set `baseURL` to the platform `/v1/runtime-proxy/vellum`
 * path and authenticate with the assistant API key. These models have no
 * bring-your-own-key path.
 */
export class VellumProvider extends OpenAIChatCompletionsProvider {
  constructor(
    apiKey: string,
    model: string,
    options: VellumProviderOptions = {},
  ) {
    super(apiKey || "not-needed", model, {
      providerName: "vellum",
      providerLabel: "Vellum",
      streamTimeoutMs: options.streamTimeoutMs,
      omitToolChoiceWhenReasoning: true,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  protected override buildRequestExtraBody(
    options?: SendMessageOptions,
  ): Record<string, unknown> | undefined {
    const config = options?.config as { model?: string } | undefined;
    return hostedDirectionsExtraBody(
      config?.model ?? this.defaultModel,
      getWorkspaceDir(),
    );
  }
}
