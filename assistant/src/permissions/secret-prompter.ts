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
}

interface PendingSecretPrompt {
  resolve: (result: SecretPromptResult) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SecretPrompter {
  private pending = new Map<string, PendingSecretPrompt>();
  private sendToClient: (msg: ServerMessage) => void;

  constructor(sendToClient: (msg: ServerMessage) => void) {
    this.sendToClient = sendToClient;
  }

  updateSender(sendToClient: (msg: ServerMessage) => void): void {
    this.sendToClient = sendToClient;
  }

  /**
   * Send a secret_request to the client and wait for the response.
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

    return new Promise((resolve, reject) => {
      const timeoutMs = getConfig().timeouts.permissionTimeoutSec * 1000;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
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
      this.sendToClient(msg);
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
  }
}
