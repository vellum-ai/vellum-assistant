import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  SecretRequest,
  ServerMessage,
} from "../daemon/message-protocol.js";

// Capture all logger calls so we can verify secret values never appear
const logCalls: Array<{ level: string; args: unknown[] }> = [];
function capture(level: string) {
  return (...args: unknown[]) => {
    logCalls.push({ level, args });
  };
}

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: capture("info"),
    warn: capture("warn"),
    error: capture("error"),
    debug: capture("debug"),
    trace: capture("trace"),
    fatal: capture("fatal"),
    child: () => ({
      info: capture("info"),
      warn: capture("warn"),
      error: capture("error"),
      debug: capture("debug"),
    }),
  }),
}));

// Capture broadcastMessage calls
const broadcastedMessages: ServerMessage[] = [];
mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: ServerMessage) => {
    broadcastedMessages.push(msg);
  },
}));

// Stub pendingInteractions — SecretPrompter registers/resolves there now
// Use a real Map so SecretPrompter can store and retrieve promptResolve/promptReject callbacks.
const _piStore = new Map<string, object>();
mock.module("../runtime/pending-interactions.js", () => ({
  register: (id: string, entry: object) => _piStore.set(id, entry),
  resolve: (id: string) => { const e = _piStore.get(id); _piStore.delete(id); return e; },
  get: (id: string) => _piStore.get(id),
  getAll: () => [..._piStore.values()],
  getByConversation: () => [],
  getByKind: () => [],
  removeByConversation: () => {},
  clear: () => _piStore.clear(),
}));

// Use a tiny timeout so the setTimeout branch fires quickly in tests
const mockConfig = {
  timeouts: { permissionTimeoutSec: 0.01 },
  secretDetection: { allowOneTimeSend: false },
};
mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
}));

// Import after mock so SecretPrompter picks up the captured logger
const { SecretPrompter } = await import("../permissions/secret-prompter.js");

/** Recursively check if a secret value appears anywhere in logged args. */
function logContainsValue(secret: string): boolean {
  return logCalls.some((call) => JSON.stringify(call.args).includes(secret));
}

describe("secret prompt log hygiene", () => {
  let prompter: InstanceType<typeof SecretPrompter>;

  beforeEach(() => {
    logCalls.length = 0;
    broadcastedMessages.length = 0;
    prompter = new SecretPrompter();
  });

  test("resolveSecret never logs the secret value", async () => {
    const secret = "sv42";
    const promise = prompter.prompt("myservice", "apikey", "API Key");
    const requestId = (broadcastedMessages[0] as SecretRequest).requestId;
    prompter.resolveSecret(requestId, secret, "store");
    const result = await promise;

    // Value is returned correctly
    expect(result.value).toBe(secret);
    // But never appears in any log call
    expect(logContainsValue(secret)).toBe(false);
  });

  test("resolveSecret for unknown requestId logs only requestId, not value", () => {
    const secret = "lk99";
    prompter.resolveSecret("no-such-id", secret, "store");

    // There should be a warn log for the unknown requestId
    expect(logCalls.some((c) => c.level === "warn")).toBe(true);
    // The secret value must not appear
    expect(logContainsValue(secret)).toBe(false);
  });

  test("prompt timeout logs only metadata, not the secret value", async () => {
    // Let the setTimeout branch in SecretPrompter.prompt() actually fire
    // (mockConfig sets permissionTimeoutSec to 0.01s = 10ms)
    const result = await prompter.prompt("svc", "key", "Label");

    // Timeout resolves with null value
    expect(result.value).toBeNull();

    // A warn log should have been emitted for the timeout
    expect(logCalls.some((c) => c.level === "warn")).toBe(true);

    // The timeout log must only contain metadata (requestId, service, field),
    // never a "value" key
    for (const call of logCalls) {
      const serialized = JSON.stringify(call.args);
      expect(serialized).not.toContain('"value"');
    }
  });

  test("sent message contains value=undefined (value flows through event, not logs)", async () => {
    const promise = prompter.prompt("svc", "tok", "Token");
    const msg = broadcastedMessages[0] as SecretRequest & { value?: unknown };
    // The message should NOT contain a value field
    expect(msg.value).toBeUndefined();
    prompter.resolveSecret(msg.requestId, undefined);
    await promise;
  });
});
