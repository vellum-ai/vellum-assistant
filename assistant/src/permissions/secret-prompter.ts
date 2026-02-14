import { v4 as uuid } from 'uuid';
import type { ServerMessage } from '../daemon/ipc-protocol.js';
import { getConfig } from '../config/loader.js';
import { getLogger } from '../util/logger.js';
import { AssistantError, ErrorCode } from '../util/errors.js';

const log = getLogger('secret-prompter');

interface PendingSecretPrompt {
  resolve: (value: string | null) => void;
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

  async prompt(
    service: string,
    field: string,
    label: string,
    description?: string,
    placeholder?: string,
    sessionId?: string,
  ): Promise<string | null> {
    const requestId = uuid();

    return new Promise((resolve, reject) => {
      const timeoutMs = getConfig().timeouts.permissionTimeoutSec * 1000;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        log.warn({ requestId, service, field }, 'Secret prompt timed out');
        resolve(null);
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });

      this.sendToClient({
        type: 'secret_request',
        requestId,
        service,
        field,
        label,
        description,
        placeholder,
        sessionId,
      });
    });
  }

  resolveSecret(requestId: string, value?: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      log.warn({ requestId }, 'No pending prompt for secret response');
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(value ?? null);
  }

  dispose(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new AssistantError('Prompter disposed', ErrorCode.INTERNAL_ERROR));
    }
    this.pending.clear();
  }
}
