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

const { SecretPrompter } = await import("../permissions/secret-prompter.js");

describe("secret prompter channel fallback", () => {
  let sentMessages: ServerMessage[];
  let broadcastMessages: ServerMessage[];

  beforeEach(() => {
    sentMessages = [];
    broadcastMessages = [];
  });

  test("fails fast with unsupported_channel error when channel lacks dynamic UI and no broadcast available", async () => {
    const prompter = new SecretPrompter((msg) => sentMessages.push(msg));
    prompter.setChannelContext({
      channel: "slack",
      supportsDynamicUi: false,
    });

    const result = await prompter.prompt("myservice", "apikey", "API Key");

    expect(result.value).toBeNull();
    expect(result.error).toBe("unsupported_channel");
    // No message should have been sent since we failed fast
    expect(sentMessages).toHaveLength(0);
  });

  test("broadcasts secret_request via SSE hub AND sends via sendToClient when channel lacks dynamic UI but broadcast is available", async () => {
    const prompter = new SecretPrompter(
      (msg) => sentMessages.push(msg),
      (msg) => broadcastMessages.push(msg),
    );
    prompter.setChannelContext({
      channel: "slack",
      supportsDynamicUi: false,
    });

    const promise = prompter.prompt("myservice", "apikey", "API Key");

    // Should have broadcast AND sent via per-channel sender (voice path needs sendToClient)
    expect(broadcastMessages).toHaveLength(1);
    expect(broadcastMessages[0]!.type).toBe("secret_request");
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.type).toBe("secret_request");

    // Resolve the prompt so it doesn't hang
    const requestId = (broadcastMessages[0] as SecretRequest).requestId;
    prompter.resolveSecret(requestId, "test-secret", "store");
    const result = await promise;
    expect(result.value).toBe("test-secret");
    expect(result.error).toBeUndefined();
  });

  test("uses sendToClient when channel supports dynamic UI", async () => {
    const prompter = new SecretPrompter(
      (msg) => sentMessages.push(msg),
      (msg) => broadcastMessages.push(msg),
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
      (msg) => broadcastMessages.push(msg),
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
      (msg) => broadcastMessages.push(msg),
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
      (msg) => broadcastMessages.push(msg),
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
