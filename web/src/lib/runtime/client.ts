/**
 * HTTP-based RuntimeClient implementation.
 *
 * Talks to any runtime that implements the canonical
 * `/v1/assistants/:assistantId/*` HTTP contract, whether that's a local
 * daemon HTTP server or a hosted cloud runtime.
 */

import type {
  RuntimeClient,
  RuntimeHealthResponse,
  ListMessagesParams,
  ListMessagesResponse,
  SendMessageParams,
  SendMessageResponse,
  GetSuggestionParams,
  GetSuggestionResponse,
  UploadAttachmentParams,
  UploadAttachmentResponse,
  DeleteAttachmentParams,
  ChannelInboundParams,
  ChannelInboundResponse,
  ChannelDeliveryAckParams,
  CreateRunParams,
  RunResponse,
  RunDecisionParams,
  RunDecisionResponse,
  AddTrustRuleParams,
  AddTrustRuleResponse,
} from "./types";

function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return url.replace(/\/\/[^@]*@/, "//[REDACTED]@");
  }
}

export class RuntimeClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeClientError";
  }

  /** Return a status safe to use in an HTTP response (200–599). Connection failures set status to 0, which is invalid. */
  get httpStatus(): number {
    return this.status >= 200 && this.status <= 599 ? this.status : 502;
  }
}

export function createRuntimeClient(
  baseUrl: string,
  assistantId: string,
  token?: string,
): RuntimeClient {
  const prefix = `${baseUrl}/v1/assistants/${assistantId}`;

  async function request<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    let response: Response;
    try {
      response = await fetch(`${prefix}${path}`, {
        ...init,
        headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
      });
    } catch (err) {
      const sanitized = sanitizeUrl(prefix);
      throw new RuntimeClientError(
        502,
        `Failed to connect to runtime at ${sanitized}${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new RuntimeClientError(response.status, body || `HTTP ${response.status}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  return {
    health() {
      return request<RuntimeHealthResponse>("/health");
    },

    listMessages(params: ListMessagesParams) {
      const qs = new URLSearchParams({ conversationKey: params.conversationKey });
      if (params.cursor) qs.set("cursor", params.cursor);
      if (params.limit != null) qs.set("limit", String(params.limit));
      return request<ListMessagesResponse>(`/messages?${qs.toString()}`);
    },

    sendMessage(params: SendMessageParams) {
      return request<SendMessageResponse>("/messages", {
        method: "POST",
        body: JSON.stringify(params),
      });
    },

    getSuggestion(params: GetSuggestionParams) {
      const qs = new URLSearchParams({ conversationKey: params.conversationKey });
      if (params.messageId) qs.set("messageId", params.messageId);
      return request<GetSuggestionResponse>(`/suggestion?${qs.toString()}`);
    },

    uploadAttachment(params: UploadAttachmentParams) {
      return request<UploadAttachmentResponse>("/attachments", {
        method: "POST",
        body: JSON.stringify(params),
      });
    },

    deleteAttachment(params: DeleteAttachmentParams) {
      return request<void>(`/attachments`, {
        method: "DELETE",
        body: JSON.stringify({ attachmentId: params.attachmentId }),
      });
    },

    channelInbound(params: ChannelInboundParams) {
      return request<ChannelInboundResponse>("/channels/inbound", {
        method: "POST",
        body: JSON.stringify(params),
      });
    },

    channelDeliveryAck(params: ChannelDeliveryAckParams) {
      return request<void>("/channels/delivery-ack", {
        method: "POST",
        body: JSON.stringify(params),
      });
    },

    createRun(params: CreateRunParams) {
      return request<RunResponse>("/runs", {
        method: "POST",
        body: JSON.stringify(params),
      });
    },

    getRun(runId: string) {
      return request<RunResponse>(`/runs/${runId}`);
    },

    submitRunDecision(runId: string, params: RunDecisionParams) {
      return request<RunDecisionResponse>(`/runs/${runId}/decision`, {
        method: "POST",
        body: JSON.stringify(params),
      });
    },

    addTrustRule(runId: string, params: AddTrustRuleParams) {
      return request<AddTrustRuleResponse>(`/runs/${runId}/trust-rule`, {
        method: "POST",
        body: JSON.stringify(params),
      });
    },
  };
}
