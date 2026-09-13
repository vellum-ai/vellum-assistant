import { randomUUID } from "node:crypto";

import { getExistingDeviceId } from "../../util/device-id.js";
import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";
import { OpenAIResponsesProvider } from "../openai/responses-provider.js";
import type {
  Message,
  ProviderResponse,
  SendMessageOptions,
} from "../types.js";

export const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen/v1";
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
export const OPENCODE_SESSION_HEADER = "x-opencode-session";
export const OPENCODE_REQUEST_HEADER = "x-opencode-request";

/** Wire API an OpenCode model is served over. */
export type OpenCodeTransport = "chat_completions" | "responses";

export interface OpenCodeProviderOptions {
  baseURL?: string;
  streamTimeoutMs?: number;
  /**
   * Explicit per-model transport from the connection's model entries
   * (`ConnectionModel.transport`). Wins over the built-in
   * {@link OPENCODE_RESPONSES_ONLY_MODELS} default for that model.
   */
  modelTransports?: Readonly<Record<string, OpenCodeTransport>>;
}

/**
 * OpenCode Zen models served only by the Responses API: Zen answers
 * `/chat/completions` for them with HTTP 500 and completes the same request
 * on `/responses`. OpenCode's own client picks the transport per model from
 * its catalog's `api.endpoint`; the assistant has no such feed, so the known
 * ids live here and a connection model entry can override the choice.
 */
export const OPENCODE_RESPONSES_ONLY_MODELS: ReadonlySet<string> = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);

/**
 * Transport for an OpenCode model: an explicit connection-level choice wins,
 * otherwise the built-in responses-only list decides.
 */
export function resolveOpenCodeTransport(
  model: string,
  configured?: OpenCodeTransport,
): OpenCodeTransport {
  if (configured) {
    return configured;
  }
  return OPENCODE_RESPONSES_ONLY_MODELS.has(model)
    ? "responses"
    : "chat_completions";
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

type OpenCodeTransportOptions = Pick<
  OpenCodeProviderOptions,
  "baseURL" | "streamTimeoutMs"
>;

/**
 * Responses-API transport for OpenCode. Shares the chat client's origin
 * resolution and provider name, so `RetryProvider` stamps the same
 * `x-opencode-session` / `x-opencode-request` headers on its requests.
 */
export class OpenCodeResponsesProvider extends OpenAIResponsesProvider {
  constructor(
    apiKey: string,
    model: string,
    options: OpenCodeTransportOptions = {},
  ) {
    super(apiKey, model, {
      baseURL: resolveOpenCodeBaseURL(options.baseURL),
      providerName: "opencode",
      providerLabel: "OpenCode",
      streamTimeoutMs: options.streamTimeoutMs,
    });
  }
}

/**
 * OpenCode adapter. Chat completions is the default wire; models resolved to
 * the Responses transport (see {@link resolveOpenCodeTransport}) are delegated
 * to an {@link OpenCodeResponsesProvider} on the same origin. The choice is
 * made per send from the effective model, so a per-call model override lands
 * on the transport that model needs.
 */
export class OpenCodeProvider extends OpenAIChatCompletionsProvider {
  private readonly openCodeApiKey: string;
  private readonly transportOptions: OpenCodeTransportOptions;
  private readonly modelTransports: ReadonlyMap<string, OpenCodeTransport>;
  private responsesInner: OpenCodeResponsesProvider | undefined;

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
    this.openCodeApiKey = apiKey;
    this.transportOptions = {
      baseURL: options.baseURL,
      streamTimeoutMs: options.streamTimeoutMs,
    };
    this.modelTransports = new Map(
      Object.entries(options.modelTransports ?? {}),
    );
  }

  /** Transport a model is sent over through this adapter. */
  resolveTransport(model: string): OpenCodeTransport {
    return resolveOpenCodeTransport(model, this.modelTransports.get(model));
  }

  /**
   * Transport-level backstop so a call that reaches this provider without
   * going through `RetryProvider` (or with no config at all) still carries
   * the session and request headers zen/go requires on either wire. Headers
   * the caller already resolved (conversation-derived) win.
   */
  override async sendMessage(
    messages: Message[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const config = options?.config ?? {};
    const stamped: SendMessageOptions = {
      ...options,
      config: {
        ...config,
        requestHeaders: {
          ...resolveOpenCodeRequestHeaders(),
          ...config.requestHeaders,
        },
      },
    };
    if (
      this.resolveTransport(this.resolveEffectiveModel(options)) === "responses"
    ) {
      return this.getResponsesInner().sendMessage(messages, stamped);
    }
    return super.sendMessage(messages, stamped);
  }

  private getResponsesInner(): OpenCodeResponsesProvider {
    this.responsesInner ??= new OpenCodeResponsesProvider(
      this.openCodeApiKey,
      this.defaultModel,
      this.transportOptions,
    );
    return this.responsesInner;
  }
}
