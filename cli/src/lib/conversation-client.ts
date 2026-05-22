export type RuntimeAuthHeaders = Record<string, string>;

export interface ConversationClientOptions {
  baseUrl: string;
  assistantId: string;
  auth?: RuntimeAuthHeaders;
  fetchImpl?: typeof fetch;
}

export interface ChannelBinding {
  sourceChannel?: string | null;
  [key: string]: unknown;
}

export interface ConversationSummary {
  id: string;
  title?: string | null;
  createdAt?: number;
  updatedAt?: number;
  lastMessageAt?: number | null;
  conversationType?: string;
  source?: string;
  channelBinding?: ChannelBinding | null;
  conversationOriginChannel?: string | null;
  conversationOriginInterface?: string | null;
  archivedAt?: number | null;
  inferenceProfile?: string | null;
  [key: string]: unknown;
}

export interface ConversationListResponse {
  conversations: ConversationSummary[];
  nextOffset?: number;
  hasMore?: boolean;
  groups?: unknown[];
}

export interface ConversationSearchResult {
  conversation: ConversationSummary;
  messages?: RuntimeMessage[];
  score?: number;
  [key: string]: unknown;
}

export interface ConversationSearchResponse {
  query: string;
  results: ConversationSearchResult[];
}

export interface ConversationCreateResponse {
  id: string;
  conversationId?: string;
  conversationKey?: string;
  conversationType?: string;
  created?: boolean;
}

export interface ConversationSwitchResponse {
  conversationId: string;
  title?: string | null;
  conversationType?: string;
  inferenceProfile?: string | null;
}

export interface RuntimeMessage {
  id?: string;
  role?: string;
  text?: string;
  content?: unknown;
  createdAt?: number;
  timestamp?: number;
  [key: string]: unknown;
}

export interface ListMessagesOptions {
  limit?: number;
  page?: "latest";
  beforeTimestamp?: number;
}

export interface ListMessagesResponse {
  messages: RuntimeMessage[];
  hasMore?: boolean;
  oldestTimestamp?: number | null;
  oldestMessageId?: string | null;
}

export interface SendMessageResponse {
  accepted: boolean;
  messageId?: string;
  conversationId?: string;
  queued?: boolean;
  requestId?: string;
}

export interface ModelInfoResponse {
  model?: string;
  provider?: string;
  configuredProviders?: unknown;
  availableModels?: unknown;
  allProviders?: unknown;
  [key: string]: unknown;
}

export interface SendMessageOptions {
  content: string;
  conversationId: string;
  signal?: AbortSignal;
  clientMessageId?: string;
  inferenceProfile?: string | null;
  riskThreshold?: string;
}

export interface RunBtwOptions {
  content: string;
  conversationId: string;
  signal?: AbortSignal;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function friendlyErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed?.error?.message) {
      return parsed.error.message;
    }
  } catch {
    // Fall through to status text.
  }
  return `HTTP ${status}: ${body || "Unknown error"}`;
}

function appendQuery(path: string, query: Record<string, string>): string {
  const params = new URLSearchParams(query);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export function getEffectiveOriginChannel(
  conversation: Pick<
    ConversationSummary,
    "channelBinding" | "conversationOriginChannel"
  >,
): string | null {
  return (
    conversation.channelBinding?.sourceChannel ??
    conversation.conversationOriginChannel ??
    null
  );
}

export function isExternalChannelReadOnly(
  conversation: Pick<
    ConversationSummary,
    "channelBinding" | "conversationOriginChannel"
  >,
): boolean {
  const originChannel = getEffectiveOriginChannel(conversation);
  if (!originChannel) return false;
  if (originChannel === "vellum") return false;
  if (originChannel.startsWith("notification:")) return false;
  return true;
}

export class ConversationClient {
  private readonly baseUrl: string;
  private readonly assistantId: string;
  private readonly auth: RuntimeAuthHeaders | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ConversationClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.assistantId = options.assistantId;
    this.auth = options.auth;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  buildEventsUrl(conversationId: string): string {
    return this.url(
      appendQuery("/events", {
        conversationId,
      }),
    );
  }

  async listConversations(options?: {
    limit?: number;
    offset?: number;
  }): Promise<ConversationListResponse> {
    const query: Record<string, string> = {};
    if (options?.limit !== undefined) query.limit = String(options.limit);
    if (options?.offset !== undefined) query.offset = String(options.offset);
    return this.request<ConversationListResponse>(
      "GET",
      appendQuery("/conversations", query),
    );
  }

  async searchConversations(options: {
    query: string;
    limit?: number;
    maxMessagesPerConversation?: number;
  }): Promise<ConversationSearchResponse> {
    const query: Record<string, string> = { q: options.query };
    if (options.limit !== undefined) query.limit = String(options.limit);
    if (options.maxMessagesPerConversation !== undefined) {
      query.maxMessagesPerConversation = String(
        options.maxMessagesPerConversation,
      );
    }
    return this.request<ConversationSearchResponse>(
      "GET",
      appendQuery("/conversations/search", query),
    );
  }

  async createConversation(): Promise<ConversationCreateResponse> {
    return this.request<ConversationCreateResponse>(
      "POST",
      "/conversations",
      {},
    );
  }

  async switchConversation(
    conversationId: string,
  ): Promise<ConversationSwitchResponse> {
    return this.request<ConversationSwitchResponse>(
      "POST",
      "/conversations/switch",
      { conversationId },
    );
  }

  async getConversation(conversationId: string): Promise<ConversationSummary> {
    return this.request<ConversationSummary>(
      "GET",
      `/conversations/${encodeURIComponent(conversationId)}`,
    );
  }

  async renameConversation(
    conversationId: string,
    name: string,
  ): Promise<unknown> {
    return this.request(
      "PATCH",
      `/conversations/${encodeURIComponent(conversationId)}/name`,
      { name },
    );
  }

  async archiveConversation(conversationId: string): Promise<unknown> {
    return this.request(
      "POST",
      `/conversations/${encodeURIComponent(conversationId)}/archive`,
      {},
    );
  }

  async listMessages(
    conversationId: string,
    options?: ListMessagesOptions,
  ): Promise<ListMessagesResponse> {
    const query: Record<string, string> = { conversationId };
    if (options?.limit !== undefined) query.limit = String(options.limit);
    if (options?.page !== undefined) query.page = options.page;
    if (options?.beforeTimestamp !== undefined) {
      query.beforeTimestamp = String(options.beforeTimestamp);
    }
    return this.request<ListMessagesResponse>(
      "GET",
      appendQuery("/messages", query),
    );
  }

  async sendMessage(options: SendMessageOptions): Promise<SendMessageResponse> {
    return this.request<SendMessageResponse>(
      "POST",
      "/messages",
      {
        conversationId: options.conversationId,
        content: options.content,
        sourceChannel: "vellum",
        interface: "cli",
        ...(options.clientMessageId
          ? { clientMessageId: options.clientMessageId }
          : {}),
        ...(options.inferenceProfile !== undefined
          ? { inferenceProfile: options.inferenceProfile }
          : {}),
        ...(options.riskThreshold
          ? { riskThreshold: options.riskThreshold }
          : {}),
      },
      options.signal,
    );
  }

  async runBtw(options: RunBtwOptions): Promise<Response> {
    return this.rawRequest(
      "POST",
      "/btw",
      {
        conversationId: options.conversationId,
        content: options.content,
      },
      options.signal,
      { Accept: "text/event-stream" },
    );
  }

  async getModelInfo(): Promise<ModelInfoResponse> {
    return this.request<ModelInfoResponse>("GET", "/model");
  }

  private url(path: string): string {
    return `${this.baseUrl}/v1/assistants/${encodeURIComponent(
      this.assistantId,
    )}${path}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.rawRequest(method, path, body, signal);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private async rawRequest(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<Response> {
    const response = await this.fetchImpl(this.url(path), {
      method,
      signal,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...this.auth,
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(friendlyErrorMessage(response.status, text));
    }

    return response;
  }
}
