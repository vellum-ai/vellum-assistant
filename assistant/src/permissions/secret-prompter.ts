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
  /**
   * Why `value` is null. `"cancelled"` = the user explicitly dismissed the
   * prompt (a valid flow, not a failure); `"timed_out"` = no response within
   * the permission-timeout window; `"superseded"` = a newer message in the
   * conversation auto-denied the pending prompt before anyone answered it.
   * Only meaningful when `value` is null and `error` is unset. Lets callers
   * distinguish a deliberate cancel from a genuine failure instead of
   * treating both as an error.
   */
  reason?: "cancelled" | "timed_out" | "superseded";
  /**
   * One-time collection URL minted when the channel cannot render the secure
   * prompt. Set together with `error: "unsupported_channel"` — the caller
   * relays the link so the user can supply the value out of band; the gateway
   * stores the submitted value via the credential vault.
   */
  collectionUrl?: string;
  /** Expiry (epoch ms) of {@link SecretPromptResult.collectionUrl}. */
  collectionExpiresAt?: number;
}

export interface SecretPrompterChannelContext {
  /** The channel the conversation was initiated from (e.g. "slack", "macos"). */
  channel?: string;
  /** Whether the channel supports rendering dynamic UI (secure prompt dialogs). */
  supportsDynamicUi?: boolean;
}

export class SecretPrompter {
  /**
   * Tracks which requestIds belong to this prompter instance so that
   * dispose can scope its cleanup to this conversation.
   * The full per-request state (callbacks, timer) lives in pendingInteractions,
   * matching the host proxy and PermissionPrompter pattern.
   */
  private ownedIds = new Set<string>();
  private channelContext?: SecretPrompterChannelContext;

  setChannelContext(ctx: SecretPrompterChannelContext | undefined): void {
    this.channelContext = ctx;
  }

  /**
   * Broadcast a secret_request to all connected clients and wait for a
   * response.
   *
   * Registers all lifecycle state (rpcResolve, rpcReject, timer) in
   * pendingInteractions before broadcasting — identical to the host proxy
   * and PermissionPrompter pattern.
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
    // Channels without dynamic UI (e.g. slack, telegram) have no surface that
    // renders the secure prompt dialog — fail fast with unsupported_channel
    // instead of broadcasting a request that can only time out.
    if (this.channelContext?.supportsDynamicUi === false) {
      log.warn(
        { service, field, channel: this.channelContext.channel },
        "Secret prompt suppressed: channel does not support secure input",
      );
      return { value: null, delivery: "store", error: "unsupported_channel" };
    }

    const requestId = uuid();
    const effectiveConversationId = conversationId ?? "unknown";

    return new Promise((resolve, reject) => {
      const timeoutMs = getConfig().timeouts.permissionTimeoutSec * 1000;

      const timer = setTimeout(() => {
        pendingInteractions.resolve(requestId, "cancelled");
        this.ownedIds.delete(requestId);
        log.warn({ requestId, service, field }, "Secret prompt timed out");
        resolve({ value: null, delivery: "store", reason: "timed_out" });
      }, timeoutMs);

      const config = getConfig();

      // Register all lifecycle state in pendingInteractions — same pattern as
      // host proxies and PermissionPrompter. The prompter tracks ownership via ownedIds.
      // SECURITY: secretDetails carries only the public prompt metadata broadcast
      // on the secret_request event — never the secret value the user will supply.
      pendingInteractions.register(requestId, {
        conversationId: effectiveConversationId,
        kind: "secret",
        secretDetails: {
          service,
          field,
          label,
          description,
          placeholder,
          purpose,
          allowedTools,
          allowedDomains,
          allowOneTimeSend: config.secretDetection.allowOneTimeSend,
        },
        rpcResolve: resolve as (value: unknown) => void,
        rpcReject: reject,
        timer,
      });
      this.ownedIds.add(requestId);

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
    return this.ownedIds.has(requestId);
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
    if (!this.ownedIds.has(requestId)) {
      log.warn({ requestId }, "No pending prompt for secret response");
      return;
    }
    // approval-routes calls pendingInteractions.get() before routing here;
    // the prompter owns deregistration so it fires the Promise callback cleanly.
    const interaction = pendingInteractions.resolve(
      requestId,
      value === undefined ? "cancelled" : "answered",
    );
    this.ownedIds.delete(requestId);
    (
      interaction?.rpcResolve as ((v: SecretPromptResult) => void) | undefined
    )?.(
      value === undefined
        ? { value: null, delivery: delivery ?? "store", reason: "cancelled" }
        : { value, delivery: delivery ?? "store" },
    );
  }

  dispose(): void {
    for (const requestId of [...this.ownedIds]) {
      const interaction = pendingInteractions.resolve(requestId, "cancelled");
      this.ownedIds.delete(requestId);
      interaction?.rpcReject?.(
        new AssistantError("Prompter disposed", ErrorCode.INTERNAL_ERROR),
      );
    }
  }
}
