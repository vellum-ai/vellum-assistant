import { v4 as uuid } from 'uuid';

import { getConfig } from '../config/loader.js';
import type { ServerMessage } from '../daemon/ipc-protocol.js';
import { redactSensitiveFields } from '../security/redaction.js';
import type { ExecutionTarget } from '../tools/types.js';
import { AssistantError, ErrorCode } from '../util/errors.js';
import { getLogger } from '../util/logger.js';
import type { AllowlistOption, ScopeOption,UserDecision } from './types.js';

const log = getLogger('permission-prompter');

interface PendingPrompt {
  resolve: (value: {
    decision: UserDecision;
    selectedPattern?: string;
    selectedScope?: string;
    decisionContext?: string;
  }) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PermissionPrompter {
  private pending = new Map<string, PendingPrompt>();
  private sendToClient: (msg: ServerMessage) => void;

  constructor(sendToClient: (msg: ServerMessage) => void) {
    this.sendToClient = sendToClient;
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
    diff?: { filePath: string; oldContent: string; newContent: string; isNewFile: boolean },
    sandboxed?: boolean,
    sessionId?: string,
    executionTarget?: ExecutionTarget,
    persistentDecisionsAllowed?: boolean,
    signal?: AbortSignal,
  ): Promise<{
    decision: UserDecision;
    selectedPattern?: string;
    selectedScope?: string;
    decisionContext?: string;
  }> {
    if (signal?.aborted) return { decision: 'deny' };

    const requestId = uuid();

    return new Promise((resolve, reject) => {
      const timeoutMs = getConfig().timeouts.permissionTimeoutSec * 1000;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        log.warn({ requestId, toolName }, 'Permission prompt timed out, defaulting to deny');
        resolve({ decision: 'deny' });
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });

      if (signal) {
        const onAbort = () => {
          if (this.pending.has(requestId)) {
            clearTimeout(timer);
            this.pending.delete(requestId);
            resolve({ decision: 'deny' });
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.sendToClient({
        type: 'confirmation_request',
        requestId,
        toolName,
        input: redactSensitiveFields(input),
        riskLevel,
        allowlistOptions: allowlistOptions.map((o) => ({ label: o.label, description: o.description, pattern: o.pattern })),
        scopeOptions: scopeOptions.map((o) => ({ label: o.label, scope: o.scope })),
        diff,
        sandboxed,
        sessionId,
        executionTarget,
        persistentDecisionsAllowed: persistentDecisionsAllowed ?? true,
      });
    });
  }

  hasPendingRequest(requestId: string): boolean {
    return this.pending.has(requestId);
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
      log.warn({ requestId }, 'No pending prompt for confirmation response');
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve({ decision, selectedPattern, selectedScope, decisionContext });
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
      pending.resolve({ decision: 'deny', decisionContext: 'The user sent a new message instead of responding to this permission prompt. Stop what you are doing and respond to the user\'s new message. Do NOT retry this tool or request permission again until the user asks you to.' });
    }
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  dispose(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new AssistantError('Prompter disposed', ErrorCode.INTERNAL_ERROR));
    }
    this.pending.clear();
  }
}
