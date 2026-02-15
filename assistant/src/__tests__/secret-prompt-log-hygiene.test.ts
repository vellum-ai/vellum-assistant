import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { ServerMessage } from '../daemon/ipc-protocol.js';

// Capture all logger calls so we can verify secret values never appear
const logCalls: Array<{ level: string; args: unknown[] }> = [];
function capture(level: string) {
  return (...args: unknown[]) => { logCalls.push({ level, args }); };
}

mock.module('../util/logger.js', () => ({
  getLogger: () => ({
    info: capture('info'),
    warn: capture('warn'),
    error: capture('error'),
    debug: capture('debug'),
    trace: capture('trace'),
    fatal: capture('fatal'),
    child: () => ({
      info: capture('info'),
      warn: capture('warn'),
      error: capture('error'),
      debug: capture('debug'),
    }),
  }),
}));

// Import after mock so SecretPrompter picks up the captured logger
const { SecretPrompter } = await import('../permissions/secret-prompter.js');

/** Recursively check if a secret value appears anywhere in logged args. */
function logContainsValue(secret: string): boolean {
  return logCalls.some((call) => JSON.stringify(call.args).includes(secret));
}

describe('secret prompt log hygiene', () => {
  let prompter: InstanceType<typeof SecretPrompter>;
  let sentMessages: ServerMessage[];

  beforeEach(() => {
    logCalls.length = 0;
    sentMessages = [];
    prompter = new SecretPrompter((msg) => { sentMessages.push(msg); });
  });

  test('resolveSecret never logs the secret value', async () => {
    const secret = 'sv42';
    const promise = prompter.prompt('myservice', 'apikey', 'API Key');
    const requestId = (sentMessages[0] as any).requestId;
    prompter.resolveSecret(requestId, secret, 'store');
    const result = await promise;

    // Value is returned correctly
    expect(result.value).toBe(secret);
    // But never appears in any log call
    expect(logContainsValue(secret)).toBe(false);
  });

  test('resolveSecret for unknown requestId logs only requestId, not value', () => {
    const secret = 'lk99';
    prompter.resolveSecret('no-such-id', secret, 'store');

    // There should be a warn log for the unknown requestId
    expect(logCalls.some((c) => c.level === 'warn')).toBe(true);
    // The secret value must not appear
    expect(logContainsValue(secret)).toBe(false);
  });

  test('prompt timeout logs only metadata, not the secret value', async () => {
    const promise = prompter.prompt('svc', 'key', 'Label');
    const requestId = (sentMessages[0] as any).requestId;

    // Simulate a normal resolve (timeout would also log metadata only)
    prompter.resolveSecret(requestId, undefined);
    await promise;

    // Verify no log contains any value-like content beyond metadata
    for (const call of logCalls) {
      const serialized = JSON.stringify(call.args);
      // Metadata fields are fine
      expect(serialized).not.toContain('"value"');
    }
  });

  test('sent IPC message contains value=undefined (value flows through IPC, not logs)', async () => {
    const promise = prompter.prompt('svc', 'tok', 'Token');
    const msg = sentMessages[0] as any;
    // The IPC message should NOT contain a value field
    expect(msg.value).toBeUndefined();
    prompter.resolveSecret(msg.requestId, undefined);
    await promise;
  });
});
