import { v4 as uuid } from 'uuid';
import type { ServerMessage } from '../daemon/ipc-protocol.js';
import type { UserDecision, AllowlistOption, ScopeOption } from './types.js';
import { getConfig } from '../config/loader.js';
import { getLogger } from '../util/logger.js';
import { AssistantError, ErrorCode } from '../util/errors.js';

const log = getLogger('permission-prompter');

interface PendingPrompt {
  resolve: (value: { decision: UserDecision; selectedPattern?: string; selectedScope?: string }) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PermissionPrompter {
  private pending = new Map<string, PendingPrompt>();
  private sendToClient: (msg: ServerMessage) => void;
  private _autoApprove = false;

  constructor(sendToClient: (msg: ServerMessage) => void) {
    this.sendToClient = sendToClient;
  }

  /**
   * When enabled, all permission prompts are immediately approved without
   * waiting for a client response. Used for HTTP API sessions where there
   * is no IPC client to respond to prompts.
   */
  setAutoApprove(enabled: boolean): void {
    this._autoApprove = enabled;
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
  ): Promise<{ decision: UserDecision; selectedPattern?: string; selectedScope?: string }> {
    if (this._autoApprove) {
      log.info({ toolName, riskLevel }, 'Auto-approving tool (no IPC client)');
      return { decision: 'allow' };
    }

    const requestId = uuid();

    return new Promise((resolve, reject) => {
      const timeoutMs = getConfig().timeouts.permissionTimeoutSec * 1000;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        log.warn({ requestId, toolName }, 'Permission prompt timed out, defaulting to deny');
        resolve({ decision: 'deny' });
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });

      this.sendToClient({
        type: 'confirmation_request',
        requestId,
        toolName,
        input,
        riskLevel,
        allowlistOptions: allowlistOptions.map((o) => ({ label: o.label, pattern: o.pattern })),
        scopeOptions: scopeOptions.map((o) => ({ label: o.label, scope: o.scope })),
        diff,
        sandboxed,
      });
    });
  }

  resolveConfirmation(
    requestId: string,
    decision: UserDecision,
    selectedPattern?: string,
    selectedScope?: string,
  ): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      log.warn({ requestId }, 'No pending prompt for confirmation response');
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve({ decision, selectedPattern, selectedScope });
  }

  dispose(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new AssistantError('Prompter disposed', ErrorCode.INTERNAL_ERROR));
    }
    this.pending.clear();
  }
}
