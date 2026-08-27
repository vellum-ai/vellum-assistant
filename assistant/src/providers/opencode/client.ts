import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";

export const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen/v1";
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
export const OPENCODE_SESSION_HEADER = "x-opencode-session";
export const OPENCODE_REQUEST_HEADER = "x-opencode-request";

export interface OpenCodeProviderOptions {
  baseURL?: string;
  streamTimeoutMs?: number;
}

/**
 * Resolve the OpenCode chat-completions origin. A stored connection URL
 * wins; otherwise the request goes to OpenCode Zen.
 */
export function resolveOpenCodeBaseURL(configuredBaseURL?: string): string {
  const trimmed = configuredBaseURL?.trim();
  if (trimmed) {
    return trimmed;
  }
  return OPENCODE_ZEN_BASE_URL;
}

/**
 * OpenCode-owned request headers for support lookup. Sends session and
 * request ids only when they exist. Never sets `session_id` (zen/go
 * returns 500 when that header is present).
 */
export function buildOpenCodeRequestHeaders(opts: {
  conversationId?: string;
  requestId?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  const session = opts.conversationId?.trim();
  if (session) {
    headers[OPENCODE_SESSION_HEADER] = session;
  }
  const requestId = opts.requestId?.trim();
  if (requestId) {
    headers[OPENCODE_REQUEST_HEADER] = requestId;
  }
  return headers;
}

export class OpenCodeProvider extends OpenAIChatCompletionsProvider {
  constructor(
    apiKey: string,
    model: string,
    options: OpenCodeProviderOptions = {},
  ) {
    super(apiKey, model, {
      baseURL: resolveOpenCodeBaseURL(options.baseURL),
      providerName: "opencode",
      providerLabel: "OpenCode",
      streamTimeoutMs: options.streamTimeoutMs,
      assistantReasoningField: "reasoning_content",
      omitToolChoiceWhenReasoning: true,
    });
  }
}
