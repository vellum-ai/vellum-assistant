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

type ConfirmResult = {
  decision: UserDecision;
  selectedPattern?: string;
  selectedScope?: string;
  decisionContext?: string;
  wasTimeout?: boolean;
  wasSystemCancel?: boolean;
};

export type ConfirmationStateCallback = (
  requestId: string,
  state: "pending" | "approved" | "denied" | "timed_out" | "resolved_stale",
  source: "button" | "inline_nl" | "auto_deny" | "timeout" | "system",
  toolUseId?: string,
) => void;

export class PermissionPrompter {
  /**
   * Tracks which requestIds belong to this prompter instance so that
   * denyAllPending / dispose can scope their cleanup to this conversation.
   * The full per-request state (callbacks, timer, toolUseId) lives in
   * pendingInteractions, matching the host proxy pattern.
   */
  private ownedIds = new Set<string>();
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
  ): Promise<ConfirmResult & { wasAbort?: boolean }> {
    if (signal?.aborted) return { decision: "deny", wasAbort: true };

    const requestId = uuid();

    return new Promise((resolve, reject) => {
      const timeoutMs = getConfig().timeouts.permissionTimeoutSec * 1000;

      const timer = setTimeout(() => {
        const interaction = pendingInteractions.resolve(requestId);
        this.ownedIds.delete(requestId);
        log.warn(
          { requestId, toolName },
          "Permission prompt timed out, defaulting to deny",
        );
        this.onStateChanged?.(requestId, "timed_out", "timeout", toolUseId);
        (interaction?.rpcResolve as ((v: ConfirmResult) => void) | undefined)?.(
          {
            decision: "deny",
            wasTimeout: true,
            decisionContext: `The permission prompt for the "${toolName}" tool timed out. The user did not explicitly deny this request — they may have been away or busy. You may retry this tool call if it is still needed for the current task.`,
          },
        );
      }, timeoutMs);

      // Register all lifecycle state in pendingInteractions — same pattern as
      // host proxies. The prompter tracks ownership via ownedIds.
      // Always register unconditionally so rpcResolve/rpcReject/timer
      // are reachable by resolveConfirmation, denyAllPending, and the timeout
      // handler even when conversationId is absent. Routes return 404 for
      // interactions with an empty conversationId, which is correct behaviour.
      pendingInteractions.register(requestId, {
        conversationId: conversationId ?? "",
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
          rpcResolve: resolve as (value: unknown) => void,
          rpcReject: reject,
          timer,
          toolUseId,
        });
      this.ownedIds.add(requestId);

      if (signal) {
        const onAbort = () => {
          if (this.ownedIds.has(requestId)) {
            pendingInteractions.resolve(requestId);
            this.ownedIds.delete(requestId);
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
    return this.ownedIds.has(requestId);
  }

  /** Returns all currently pending request IDs. */
  getPendingRequestIds(): string[] {
    return [...this.ownedIds];
  }

  /** Returns the toolUseId associated with a pending request, if any. */
  getToolUseId(requestId: string): string | undefined {
    return pendingInteractions.get(requestId)?.toolUseId;
  }

  resolveConfirmation(
    requestId: string,
    decision: UserDecision,
    selectedPattern?: string,
    selectedScope?: string,
    decisionContext?: string,
  ): void {
    if (!this.ownedIds.has(requestId)) {
      log.warn({ requestId }, "No pending prompt for confirmation response");
      return;
    }
    // The prompter owns deregistration; all callers use get() to peek before
    // routing to resolveConfirmation, which fires the rpcResolve callback.
    const interaction = pendingInteractions.resolve(requestId);
    this.ownedIds.delete(requestId);
    (interaction?.rpcResolve as ((v: ConfirmResult) => void) | undefined)?.(
      { decision, selectedPattern, selectedScope, decisionContext },
    );
  }

  /**
   * Deny all pending confirmation prompts at once. Used when a new user
   * message arrives while confirmations are outstanding — the agent will
   * see the denial and can re-request if still needed.
   */
  denyAllPending(): void {
    for (const requestId of [...this.ownedIds]) {
      const interaction = pendingInteractions.resolve(requestId);
      this.ownedIds.delete(requestId);
      (interaction?.rpcResolve as ((v: ConfirmResult) => void) | undefined)?.(
        {
          decision: "deny",
          wasSystemCancel: true,
          decisionContext:
            "The user sent a new message instead of responding to this permission prompt. Stop what you are doing and respond to the user's new message. Do NOT retry this tool or request permission again until the user asks you to.",
        },
      );
    }
  }

  get hasPending(): boolean {
    return this.ownedIds.size > 0;
  }

  dispose(): void {
    for (const requestId of [...this.ownedIds]) {
      const interaction = pendingInteractions.resolve(requestId);
      this.ownedIds.delete(requestId);
      interaction?.rpcReject?.(
        new AssistantError("Prompter disposed", ErrorCode.INTERNAL_ERROR),
      );
    }
  }
}
