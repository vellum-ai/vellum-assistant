import type { AssistantConnection } from "../types.js";

export interface SendMessageOptions {
  readonly content: string;
  readonly conversationKey?: string;
  readonly slashCommand?: string;
  readonly clientTimezone?: string;
}

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
      ...(options.conversationKey
        ? { conversationKey: options.conversationKey }
        : {}),
      ...(options.slashCommand ? { slashCommand: options.slashCommand } : {}),
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
}
