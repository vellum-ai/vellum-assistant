import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { SecretRequestEvent } from "../api/events/secret-request.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { setConfig } from "./helpers/set-config.js";

// Use a tiny timeout so the setTimeout branch fires quickly in tests
setConfig("timeouts", { permissionTimeoutSec: 0.01 });
setConfig("secretDetection", { allowOneTimeSend: false });

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
  resolve: (id: string) => {
    const e = _piStore.get(id);
    _piStore.delete(id);
    return e;
  },
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

  test("short-circuits with unsupported_channel when the channel lacks dynamic UI", async () => {
    /**
     * A channel without dynamic UI (slack, telegram, …) has no surface that
     * renders the secure prompt. Broadcasting anyway leaves the request
     * pending until it times out — which callers then misreport as a user
     * cancellation. The prompter must fail fast instead: no broadcast, no
     * pending interaction, an explicit unsupported_channel error.
     */
    const prompter = new SecretPrompter();
    prompter.setChannelContext({
      channel: "slack",
      supportsDynamicUi: false,
    });

    const result = await prompter.prompt("myservice", "apikey", "API Key");

    expect(result.value).toBeNull();
    expect(result.error).toBe("unsupported_channel");
    expect(broadcastMessages).toHaveLength(0);
    expect(_piStore.size).toBe(0);
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

    const requestId = (broadcastMessages[0] as SecretRequestEvent).requestId;
    prompter.resolveSecret(requestId, "test-secret", "store");
    await promise;
  });

  test("broadcasts secret_request when no channel context is set (desktop default)", async () => {
    const prompter = new SecretPrompter();

    const promise = prompter.prompt("myservice", "apikey", "API Key");

    expect(broadcastMessages).toHaveLength(1);
    expect(broadcastMessages[0]!.type).toBe("secret_request");

    const requestId = (broadcastMessages[0] as SecretRequestEvent).requestId;
    prompter.resolveSecret(requestId, "val", "store");
    await promise;
  });

  test("resolveSecret cleans up pending state", async () => {
    const prompter = new SecretPrompter();

    const promise = prompter.prompt("myservice", "apikey", "API Key");
    const requestId = (broadcastMessages[0] as SecretRequestEvent).requestId;

    expect(prompter.hasPendingRequest(requestId)).toBe(true);

    prompter.resolveSecret(requestId, "secret", "store");
    expect(prompter.hasPendingRequest(requestId)).toBe(false);

    await promise;
  });

  test("a timed-out prompt is tagged timed_out, not a user cancel", async () => {
    const prompter = new SecretPrompter();

    const result = await prompter.prompt("myservice", "apikey", "API Key");

    expect(result.value).toBeNull();
    expect(result.reason).toBe("timed_out");
    expect(result.error).toBeUndefined();
  });

  test("an explicit dismissal is tagged cancelled", async () => {
    const prompter = new SecretPrompter();

    const promise = prompter.prompt("myservice", "apikey", "API Key");
    const requestId = (broadcastMessages[0] as SecretRequestEvent).requestId;
    prompter.resolveSecret(requestId, undefined, "store");

    const result = await promise;
    expect(result.value).toBeNull();
    expect(result.reason).toBe("cancelled");
  });
});
