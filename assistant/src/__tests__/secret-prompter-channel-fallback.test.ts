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

const { SecretPrompter } = await import("../permissions/secret-prompter.js");

describe("secret prompter channel fallback", () => {
  let sentMessages: ServerMessage[];

  beforeEach(() => {
    sentMessages = [];
    broadcastMessages = [];
  });

  test("broadcasts and sends via sendToClient when channel lacks dynamic UI", async () => {
    const prompter = new SecretPrompter((msg) => sentMessages.push(msg));
    prompter.setChannelContext({
      channel: "slack",
      supportsDynamicUi: false,
    });

    const promise = prompter.prompt("myservice", "apikey", "API Key");

    expect(broadcastMessages).toHaveLength(1);
    expect(broadcastMessages[0]!.type).toBe("secret_request");
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.type).toBe("secret_request");

    const requestId = (broadcastMessages[0] as SecretRequest).requestId;
    prompter.resolveSecret(requestId, "test-secret", "store");
    const result = await promise;
    expect(result.value).toBe("test-secret");
  });

  test("uses sendToClient when channel supports dynamic UI", async () => {
    const prompter = new SecretPrompter(
      (msg) => sentMessages.push(msg),
    );
    prompter.setChannelContext({
      channel: "macos",
      supportsDynamicUi: true,
    });

    const promise = prompter.prompt("myservice", "apikey", "API Key");

    // Should use per-channel sender, not broadcast
    expect(sentMessages).toHaveLength(1);
    expect(broadcastMessages).toHaveLength(0);
    expect(sentMessages[0]!.type).toBe("secret_request");

    const requestId = (sentMessages[0] as SecretRequest).requestId;
    prompter.resolveSecret(requestId, "test-secret", "store");
    await promise;
  });

  test("uses sendToClient when no channel context is set (desktop default)", async () => {
    const prompter = new SecretPrompter(
      (msg) => sentMessages.push(msg),
    );
    // No setChannelContext call — desktop default

    const promise = prompter.prompt("myservice", "apikey", "API Key");

    expect(sentMessages).toHaveLength(1);
    expect(broadcastMessages).toHaveLength(0);

    const requestId = (sentMessages[0] as SecretRequest).requestId;
    prompter.resolveSecret(requestId, "val", "store");
    await promise;
  });

  test("wasBroadcast returns true for broadcast requestIds and false after resolve", async () => {
    const prompter = new SecretPrompter(
      (msg) => sentMessages.push(msg),
    );
    prompter.setChannelContext({
      channel: "slack",
      supportsDynamicUi: false,
    });

    const promise = prompter.prompt("myservice", "apikey", "API Key");
    const requestId = (broadcastMessages[0] as SecretRequest).requestId;

    // Should be tracked as broadcast
    expect(prompter.wasBroadcast(requestId)).toBe(true);

    // After resolving, the tracking should be cleaned up
    prompter.resolveSecret(requestId, "secret", "store");
    expect(prompter.wasBroadcast(requestId)).toBe(false);

    await promise;
  });

  test("wasBroadcast returns false for non-broadcast requestIds (desktop channel)", async () => {
    const prompter = new SecretPrompter(
      (msg) => sentMessages.push(msg),
    );
    prompter.setChannelContext({
      channel: "macos",
      supportsDynamicUi: true,
    });

    const promise = prompter.prompt("myservice", "apikey", "API Key");
    const requestId = (sentMessages[0] as SecretRequest).requestId;

    // Desktop channel does not broadcast, so wasBroadcast should be false
    expect(prompter.wasBroadcast(requestId)).toBe(false);

    prompter.resolveSecret(requestId, "secret", "store");
    await promise;
  });
});
