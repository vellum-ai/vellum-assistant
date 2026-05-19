import type { AssistantConnection } from "../types.js";

export interface SendMessageOptions {
  readonly content: string;
  readonly conversationKey?: string;
  readonly slashCommand?: string;
  readonly clientMessageId?: string;
  readonly clientTimezone?: string;
}

const DEFAULT_LOCAL_HANDOFF_CONVERSATION_KEY = "default:vellum:handoff";

/**
 * Minimal HTTP client for the gateway-fronted assistant API. Mirrors the
 * shape of `POST /v1/messages` from the daemon — see
 * `assistant/src/runtime/routes/conversation-routes.ts` for the canonical
 * schema. We intentionally only model the fields the HUD uses; the
 * daemon ignores unknown body fields.
 */
export class GatewayClient {
  constructor(private readonly connection: AssistantConnection) {}

  async sendMessage(options: SendMessageOptions): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Vellum-Interface-Id": "tauri",
    };
    if (this.connection.bearerToken) {
      headers["Authorization"] = `Bearer ${this.connection.bearerToken}`;
    }

    const body = {
      content: options.content,
      sourceChannel: "vellum",
      interface: "tauri",
      conversationKey:
        options.conversationKey ?? DEFAULT_LOCAL_HANDOFF_CONVERSATION_KEY,
      ...(options.slashCommand ? { slashCommand: options.slashCommand } : {}),
      ...(options.clientMessageId
        ? { clientMessageId: options.clientMessageId }
        : {}),
      clientTimezone:
        options.clientTimezone ??
        Intl.DateTimeFormat().resolvedOptions().timeZone,
    };

    const response = await fetch(`${this.connection.httpBaseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok && response.status !== 202) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `POST /v1/messages failed: ${response.status} ${text || response.statusText}`,
      );
    }
  }

  async postJson(
    endpoint: string,
    body: unknown,
    options: { readonly clientId?: string } = {},
  ): Promise<void> {
    const response = await this.postJsonRequest(endpoint, body, options);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `POST /v1/${endpoint} failed: ${response.status} ${text || response.statusText}`,
      );
    }
  }

  async postJsonResult<T>(
    endpoint: string,
    body: unknown,
    options: { readonly clientId?: string } = {},
  ): Promise<T> {
    const response = await this.postJsonRequest(endpoint, body, options);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `POST /v1/${endpoint} failed: ${response.status} ${text || response.statusText}`,
      );
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  private async postJsonRequest(
    endpoint: string,
    body: unknown,
    options: { readonly clientId?: string },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Vellum-Interface-Id": "tauri",
    };
    if (options.clientId) {
      headers["X-Vellum-Client-Id"] = options.clientId;
    }
    if (this.connection.bearerToken) {
      headers["Authorization"] = `Bearer ${this.connection.bearerToken}`;
    }

    const response = await fetch(
      `${this.connection.httpBaseUrl}/v1/${endpoint}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
    );
    return response;
  }
}
