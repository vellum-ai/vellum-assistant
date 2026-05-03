import { v4 as uuid } from "uuid";

import { getConfig } from "../config/loader.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { redactSensitiveFields } from "../security/redaction.js";
import type { ExecutionTarget } from "../tools/types.js";
import { AssistantError, ErrorCode } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import type { AllowlistOption, ScopeOption, UserDecision } from "./types.js";

const log = getLogger("permission-prompter");

interface PendingPrompt {
  resolve: (value: {
    decision: UserDecision;
    selectedPattern?: string;
    selectedScope?: string;
    decisionContext?: string;
    wasTimeout?: boolean;
    wasSystemCancel?: boolean;
  }) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  toolUseId?: string;
}

export type ConfirmationStateCallback = (
  requestId: string,
  state: "pending" | "approved" | "denied" | "timed_out" | "resolved_stale",
  source: "button" | "inline_nl" | "auto_deny" | "timeout" | "system",
  toolUseId?: string,
) => void;

export class PermissionPrompter {
  private pending = new Map<string, PendingPrompt>();
  private sendToClient: (msg: ServerMessage) => void;
  private onStateChanged?: ConfirmationStateCallback;

  constructor(sendToClient: (msg: ServerMessage) => void) {
    this.sendToClient = sendToClient;
  }

  setOnStateChanged(cb: ConfirmationStateCallback): void {
    this.onStateChanged = cb;
  }

  updateSender(sendToClient: (msg: ServerMessage) => void): void {
    this.sendToClient = sendToClient;
  }

  async prompt(
    toolName: string,
    input: Record<string, unknown>,
    riskLevel: string,
    allowlistOptions: AllowlistOption[],
    scopeOptions: ScopeOption[],
    diff?: {
      filePath: string;
      oldContent: string;
      newContent: string;
      isNewFile: boolean;
    },
    conversationId?: string,
    executionTarget?: ExecutionTarget,
    persistentDecisionsAllowed?: boolean,
    signal?: AbortSignal,
    toolUseId?: string,
    riskReason?: string,
    isContainerized?: boolean,
    directoryScopeOptions?: readonly { scope: string; label: string }[],
  ): Promise<{
    decision: UserDecision;
    selectedPattern?: string;
    selectedScope?: string;
    decisionContext?: string;
    wasTimeout?: boolean;
    wasSystemCancel?: boolean;
    wasAbort?: boolean;
  }> {
    if (signal?.aborted) return { decision: "deny", wasAbort: true };

    const requestId = uuid();

    // Self-register in pendingInteractions so /v1/confirm can route the
    // response to this conversation without going through broadcastMessage.
    if (conversationId) {
      pendingInteractions.register(requestId, {
        conversationId,
        kind: "confirmation",
        confirmationDetails: {
          toolName,
          input: redactSensitiveFields(input),
          riskLevel,
          executionTarget,
          allowlistOptions: allowlistOptions.map((o) => ({
            label: o.label,
            description: o.description,
            pattern: o.pattern,
          })),
          scopeOptions: scopeOptions.map((o) => ({
            label: o.label,
            scope: o.scope,
          })),
          persistentDecisionsAllowed: persistentDecisionsAllowed ?? true,
        },
      });
    }

    return new Promise((resolve, reject) => {
      const timeoutMs = getConfig().timeouts.permissionTimeoutSec * 1000;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        pendingInteractions.resolve(requestId);
        log.warn(
          { requestId, toolName },
          "Permission prompt timed out, defaulting to deny",
        );
        this.onStateChanged?.(requestId, "timed_out", "timeout", toolUseId);
        resolve({
          decision: "deny",
          wasTimeout: true,
          decisionContext: `The permission prompt for the "${toolName}" tool timed out. The user did not explicitly deny this request — they may have been away or busy. You may retry this tool call if it is still needed for the current task.`,
        });
      }, timeoutMs);

      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        toolUseId,
      });

      if (signal) {
        const onAbort = () => {
          if (this.pending.has(requestId)) {
            clearTimeout(timer);
            this.pending.delete(requestId);
            pendingInteractions.resolve(requestId);
            resolve({ decision: "deny", wasAbort: true });
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.sendToClient({
        type: "confirmation_request",
        requestId,
        toolName,
        input: redactSensitiveFields(input),
        riskLevel,
        riskReason,
        isContainerized,
        allowlistOptions: allowlistOptions.map((o) => ({
          label: o.label,
          description: o.description,
          pattern: o.pattern,
        })),
        scopeOptions: scopeOptions.map((o) => ({
          label: o.label,
          scope: o.scope,
        })),
        directoryScopeOptions: directoryScopeOptions
          ? directoryScopeOptions.map((o) => ({ scope: o.scope, label: o.label }))
          : undefined,
        diff,
        conversationId,
        executionTarget,
        persistentDecisionsAllowed: persistentDecisionsAllowed ?? true,
        toolUseId,
      });

      this.onStateChanged?.(requestId, "pending", "system", toolUseId);
    });
  }

  hasPendingRequest(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /** Returns all currently pending request IDs. */
  getPendingRequestIds(): string[] {
    return [...this.pending.keys()];
  }

  /** Returns the toolUseId associated with a pending request, if any. */
  getToolUseId(requestId: string): string | undefined {
    return this.pending.get(requestId)?.toolUseId;
  }

  resolveConfirmation(
    requestId: string,
    decision: UserDecision,
    selectedPattern?: string,
    selectedScope?: string,
    decisionContext?: string,
  ): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      log.warn({ requestId }, "No pending prompt for confirmation response");
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    // Idempotent — approval-routes already calls pendingInteractions.resolve()
    // before routing here, but we call it defensively for non-route paths.
    pendingInteractions.resolve(requestId);
    pending.resolve({
      decision,
      selectedPattern,
      selectedScope,
      decisionContext,
    });
  }

  /**
   * Deny all pending confirmation prompts at once. Used when a new user
   * message arrives while confirmations are outstanding — the agent will
   * see the denial and can re-request if still needed.
   */
  denyAllPending(): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pendingInteractions.resolve(requestId);
      pending.resolve({
        decision: "deny",
        wasSystemCancel: true,
        decisionContext:
          "The user sent a new message instead of responding to this permission prompt. Stop what you are doing and respond to the user's new message. Do NOT retry this tool or request permission again until the user asks you to.",
      });
    }
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
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
