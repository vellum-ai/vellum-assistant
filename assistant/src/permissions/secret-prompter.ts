import { v4 as uuid } from "uuid";

import { getConfig } from "../config/loader.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
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
  private sendToClient: (msg: ServerMessage) => void;
  private broadcastToAllClients?: (msg: ServerMessage) => void;
  private channelContext?: SecretPrompterChannelContext;
  /** Tracks requestIds that have been broadcast to prevent duplicate delivery when sendToClient also publishes to the same hub. */
  private broadcastedRequestIds = new Set<string>();

  constructor(
    sendToClient: (msg: ServerMessage) => void,
    broadcastToAllClients?: (msg: ServerMessage) => void,
  ) {
    this.sendToClient = sendToClient;
    this.broadcastToAllClients = broadcastToAllClients;
  }

  updateSender(sendToClient: (msg: ServerMessage) => void): void {
    this.sendToClient = sendToClient;
  }

  setChannelContext(ctx: SecretPrompterChannelContext | undefined): void {
    this.channelContext = ctx;
  }

  /**
   * Send a secret_request to the client and wait for the response.
   *
   * When the conversation originates from a channel that cannot render secure
   * prompts (e.g. Slack), the request is broadcast to all connected clients
   * via the SSE hub so the desktop app can display it. If no broadcast path
   * is available and the channel doesn't support dynamic UI, the method
   * fails fast with an error result rather than hanging until timeout.
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
    // Determine whether the originating channel can render secure prompts.
    const channelSupportsPrompt =
      this.channelContext?.supportsDynamicUi !== false;

    // If the channel cannot render the prompt and there's no broadcast path
    // to reach a desktop client, fail fast instead of hanging for 5 minutes.
    if (!channelSupportsPrompt && !this.broadcastToAllClients) {
      log.warn(
        { service, field, channel: this.channelContext?.channel },
        "Secret prompt requested from a channel that cannot render it and no broadcast path is available",
      );
      return { value: null, delivery: "store", error: "unsupported_channel" };
    }

    const requestId = uuid();

    return new Promise((resolve, reject) => {
      const timeoutMs = getConfig().timeouts.permissionTimeoutSec * 1000;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.broadcastedRequestIds.delete(requestId);
        log.warn({ requestId, service, field }, "Secret prompt timed out");
        resolve({ value: null, delivery: "store" });
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });

      const config = getConfig();
      const msg: SecretRequestMessage = {
        type: "secret_request",
        requestId,
        service,
        field,
        label,
        description,
        placeholder,
        conversationId,
        purpose,
        allowedTools,
        allowedDomains,
        allowOneTimeSend: config.secretDetection.allowOneTimeSend,
      };

      // When the originating channel cannot render secure prompts, broadcast
      // to the SSE hub so a connected desktop client can pick it up.
      // Track the requestId to prevent duplicate delivery when sendToClient
      // also publishes to the same hub (e.g. voice path).
      if (!channelSupportsPrompt && this.broadcastToAllClients) {
        this.broadcastedRequestIds.add(requestId);
        this.broadcastToAllClients(msg);
      }
      this.sendToClient(msg);
    });
  }

  hasPendingRequest(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /**
   * Returns true if the given requestId was already delivered via broadcastToAllClients.
   * Used by event-hub publishing paths to deduplicate — when sendToClient also
   * publishes to the same hub, callers can skip re-publishing broadcast messages.
   */
  wasBroadcast(requestId: string): boolean {
    return this.broadcastedRequestIds.has(requestId);
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
    this.broadcastedRequestIds.delete(requestId);
    pending.resolve({ value: value ?? null, delivery: delivery ?? "store" });
  }

  dispose(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new AssistantError("Prompter disposed", ErrorCode.INTERNAL_ERROR),
      );
    }
    this.pending.clear();
    this.broadcastedRequestIds.clear();
  }
}
