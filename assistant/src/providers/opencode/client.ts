import { randomUUID } from "node:crypto";

import { getExistingDeviceId } from "../../util/device-id.js";
import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";
import type {
  Message,
  ProviderResponse,
  SendMessageOptions,
} from "../types.js";

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
 *
 * `conversationId` wins for the session header; `fallbackSessionId` covers
 * non-conversation calls so they still identify a session to zen/go.
 */
export function buildOpenCodeRequestHeaders(opts: {
  conversationId?: string;
  fallbackSessionId?: string;
  requestId?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  const session = opts.conversationId?.trim() || opts.fallbackSessionId?.trim();
  if (session) {
    headers[OPENCODE_SESSION_HEADER] = session;
  }
  const requestId = opts.requestId?.trim();
  if (requestId) {
    headers[OPENCODE_REQUEST_HEADER] = requestId;
  }
  return headers;
}

let fallbackSessionId: string | undefined;

/** @internal */
export function resetOpenCodeFallbackSessionForTests(): void {
  fallbackSessionId = undefined;
}

/**
 * Headers for one outgoing OpenCode request. The session header is never
 * omitted, because zen/go rejects requests without `x-opencode-session`:
 * `conversationId` when the call has one, otherwise a fallback resolved
 * once per process (the stable per-device ID if device.json exists at that
 * point, else a fresh UUID) and pinned, so non-conversation traffic stays on
 * one session even if device.json is created later. Transport metadata
 * only; nothing here enters the request body.
 */
export function resolveOpenCodeRequestHeaders(
  conversationId?: string,
): Record<string, string> {
  fallbackSessionId ??= getExistingDeviceId() ?? randomUUID();
  return buildOpenCodeRequestHeaders({
    conversationId,
    fallbackSessionId,
    requestId: randomUUID(),
  });
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

  /**
   * Transport-level backstop so a call that reaches this provider without
   * going through `RetryProvider` (or with no config at all) still carries
   * the session and request headers zen/go requires. Headers the caller
   * already resolved (conversation-derived) win.
   */
  override async sendMessage(
    messages: Message[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const config = options?.config ?? {};
    return super.sendMessage(messages, {
      ...options,
      config: {
        ...config,
        requestHeaders: {
          ...resolveOpenCodeRequestHeaders(),
          ...config.requestHeaders,
        },
      },
    });
  }
}
