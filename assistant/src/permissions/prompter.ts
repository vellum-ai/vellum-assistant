import { v4 as uuid } from 'uuid';
import type { ServerMessage } from '../daemon/ipc-protocol.js';
import type { UserDecision, AllowlistOption, ScopeOption } from './types.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('permission-prompter');

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface PendingPrompt {
  resolve: (value: { decision: UserDecision; selectedPattern?: string; selectedScope?: string }) => void;
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
  ): Promise<{ decision: UserDecision; selectedPattern?: string; selectedScope?: string }> {
    const requestId = uuid();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        log.warn({ requestId, toolName }, 'Permission prompt timed out, defaulting to deny');
        resolve({ decision: 'deny' });
      }, TIMEOUT_MS);

      this.pending.set(requestId, { resolve, reject, timer });

      this.sendToClient({
        type: 'confirmation_request',
        requestId,
        toolName,
        input,
        riskLevel,
        allowlistOptions: allowlistOptions.map((o) => ({ label: o.label, pattern: o.pattern })),
        scopeOptions: scopeOptions.map((o) => ({ label: o.label, scope: o.scope })),
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
      pending.reject(new Error('Prompter disposed'));
    }
    this.pending.clear();
  }
}
