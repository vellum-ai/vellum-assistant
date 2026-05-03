import { v4 as uuid } from "uuid";

import { getConfig } from "../config/loader.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { AssistantError, ErrorCode } from "../util/errors.js";
import { getLogger } from "../util/logger.js";

type SecretRequestMessage = Extract<ServerMessage, { type: "secret_request" }>;

const log = getLogger("secret-prompter");

export type SecretDelivery = "store" | "transient_send";

export interface SecretPromptResult {
  value: string | null;
  delivery: SecretDelivery;
  /** When set, the prompt could not be delivered and the value is null due to a delivery failure (not user cancellation). */
  error?: "unsupported_channel";
}

interface PendingSecretPrompt {
  resolve: (result: SecretPromptResult) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SecretPrompterChannelContext {
  /** The channel the conversation was initiated from (e.g. "slack", "macos"). */
  channel?: string;
  /** Whether the channel supports rendering dynamic UI (secure prompt dialogs). */
  supportsDynamicUi?: boolean;
}

export class SecretPrompter {
  private pending = new Map<string, PendingSecretPrompt>();
  private channelContext?: SecretPrompterChannelContext;

  setChannelContext(ctx: SecretPrompterChannelContext | undefined): void {
    this.channelContext = ctx;
  }

  /**
   * Broadcast a secret_request to all connected clients and wait for a
   * response.
   *
   * The request is always published to the SSE hub via
   * {@link broadcastMessage} so any connected client (desktop, web) can
   * display the secure prompt dialog.
   *
   * Pending interaction registration is handled by {@link broadcastMessage}
   * when the secret_request event is published to the hub.
   *
   * SECURITY: Logs only metadata (requestId, service, field) — never the
   * returned secret value. The timeout path also returns a null value
   * without logging anything sensitive.
   */
  async prompt(
    service: string,
    field: string,
    label: string,
    description?: string,
    placeholder?: string,
    conversationId?: string,
    purpose?: string,
    allowedTools?: string[],
    allowedDomains?: string[],
  ): Promise<SecretPromptResult> {
    const requestId = uuid();
    const effectiveConversationId = conversationId ?? "unknown";

    return new Promise((resolve, reject) => {
      const timeoutMs = getConfig().timeouts.permissionTimeoutSec * 1000;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        pendingInteractions.resolve(requestId);
        log.warn({ requestId, service, field }, "Secret prompt timed out");
        resolve({ value: null, delivery: "store" });
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });

      // Self-register in pendingInteractions so /v1/secret can route the
      // response to this conversation without relying on broadcastMessage.
      pendingInteractions.register(requestId, {
        conversationId: effectiveConversationId,
        kind: "secret",
      });

      const config = getConfig();
      const msg: SecretRequestMessage = {
        type: "secret_request",
        requestId,
        service,
        field,
        label,
        description,
        placeholder,
        conversationId: effectiveConversationId,
        purpose,
        allowedTools,
        allowedDomains,
        allowOneTimeSend: config.secretDetection.allowOneTimeSend,
      };

      broadcastMessage(msg);
    });
  }

  hasPendingRequest(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /**
   * Resolve a pending secret prompt with the user-supplied value.
   *
   * SECURITY: This method intentionally never logs `value`. All log
   * statements must use metadata-only fields (requestId, service, field).
   * Any future change that adds logging here must be audited for leaks.
   */
  resolveSecret(
    requestId: string,
    value?: string,
    delivery?: SecretDelivery,
  ): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      log.warn({ requestId }, "No pending prompt for secret response");
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    // Clean up the global map (may already be removed by approval-routes).
    pendingInteractions.resolve(requestId);
    pending.resolve({ value: value ?? null, delivery: delivery ?? "store" });
  }

  dispose(): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pendingInteractions.resolve(requestId);
      pending.reject(
        new AssistantError("Prompter disposed", ErrorCode.INTERNAL_ERROR),
      );
    }
    this.pending.clear();
  }
}
