import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  SecretRequest,
  ServerMessage,
} from "../daemon/message-protocol.js";

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

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }),
}));

let broadcastMessages: ServerMessage[] = [];
mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: ServerMessage) => broadcastMessages.push(msg),
}));

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

const { SecretPrompter } = await import("../permissions/secret-prompter.js");

describe("secret prompter channel fallback", () => {
  beforeEach(() => {
    broadcastMessages = [];
  });

  test("broadcasts secret_request when channel lacks dynamic UI", async () => {
    const prompter = new SecretPrompter();
    prompter.setChannelContext({
      channel: "slack",
      supportsDynamicUi: false,
    });

    const promise = prompter.prompt("myservice", "apikey", "API Key");

    expect(broadcastMessages).toHaveLength(1);
    expect(broadcastMessages[0]!.type).toBe("secret_request");

    const requestId = (broadcastMessages[0] as SecretRequest).requestId;
    prompter.resolveSecret(requestId, "test-secret", "store");
    const result = await promise;
    expect(result.value).toBe("test-secret");
  });

  test("broadcasts secret_request when channel supports dynamic UI", async () => {
    const prompter = new SecretPrompter();
    prompter.setChannelContext({
      channel: "macos",
      supportsDynamicUi: true,
    });

    const promise = prompter.prompt("myservice", "apikey", "API Key");

    expect(broadcastMessages).toHaveLength(1);
    expect(broadcastMessages[0]!.type).toBe("secret_request");

    const requestId = (broadcastMessages[0] as SecretRequest).requestId;
    prompter.resolveSecret(requestId, "test-secret", "store");
    await promise;
  });

  test("broadcasts secret_request when no channel context is set (desktop default)", async () => {
    const prompter = new SecretPrompter();

    const promise = prompter.prompt("myservice", "apikey", "API Key");

    expect(broadcastMessages).toHaveLength(1);
    expect(broadcastMessages[0]!.type).toBe("secret_request");

    const requestId = (broadcastMessages[0] as SecretRequest).requestId;
    prompter.resolveSecret(requestId, "val", "store");
    await promise;
  });

  test("resolveSecret cleans up pending state", async () => {
    const prompter = new SecretPrompter();

    const promise = prompter.prompt("myservice", "apikey", "API Key");
    const requestId = (broadcastMessages[0] as SecretRequest).requestId;

    expect(prompter.hasPendingRequest(requestId)).toBe(true);

    prompter.resolveSecret(requestId, "secret", "store");
    expect(prompter.hasPendingRequest(requestId)).toBe(false);

    await promise;
  });
});
