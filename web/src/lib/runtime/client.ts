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
} from "./types";

function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return `${parsed.protocol}//${parsed.host}`;
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
      const sanitized = sanitizeUrl(baseUrl);
      throw new RuntimeClientError(
        0,
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
  };
}
