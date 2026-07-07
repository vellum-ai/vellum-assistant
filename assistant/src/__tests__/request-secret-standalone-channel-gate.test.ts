/**
 * Verifies the channel gate in `requestSecretStandalone`: a prompt scoped to
 * a conversation whose channel cannot render dynamic UI (slack, telegram, …)
 * must resolve immediately with `unsupported_channel` instead of broadcasting
 * a `secret_request` that no surface can render — which would otherwise sit
 * pending until it times out and get misreported as a user cancellation.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ServerMessage } from "../daemon/message-protocol.js";

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
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

let broadcastMessages: ServerMessage[] = [];
mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: ServerMessage) => broadcastMessages.push(msg),
}));

const _piStore = new Map<string, { rpcResolve?: (value: unknown) => void }>();
mock.module("../runtime/pending-interactions.js", () => ({
  register: (id: string, entry: object) =>
    _piStore.set(id, entry as { rpcResolve?: (value: unknown) => void }),
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

// Controls what the conversation registry returns for the test conversation.
// The shape only needs the capability fields `conversationSupportsDynamicUi`
// projects — the real projection is a dependency-free leaf and runs unmocked.
let registeredConversation:
  | {
      currentTurnChannelCapabilities?: { supportsDynamicUi: boolean };
      channelCapabilities?: { supportsDynamicUi: boolean };
    }
  | undefined;
mock.module("../daemon/conversation-registry.js", () => ({
  findConversation: (conversationId: string | undefined) =>
    conversationId === "conv-1" ? registeredConversation : undefined,
}));

const { requestSecretStandalone } =
  await import("../daemon/handlers/shared.js");

describe("requestSecretStandalone channel gate", () => {
  beforeEach(() => {
    broadcastMessages = [];
    _piStore.clear();
    registeredConversation = undefined;
  });

  test("short-circuits with unsupported_channel for a non-dynamic-UI conversation", async () => {
    // GIVEN the target conversation's channel cannot render dynamic UI
    registeredConversation = {
      channelCapabilities: { supportsDynamicUi: false },
    };

    // WHEN a standalone prompt is scoped to that conversation
    const result = await requestSecretStandalone({
      service: "stripe",
      field: "api_key",
      label: "Stripe API Key",
      conversationId: "conv-1",
    });

    // THEN it fails fast without broadcasting or registering anything
    expect(result.value).toBeNull();
    expect(result.error).toBe("unsupported_channel");
    expect(broadcastMessages).toHaveLength(0);
    expect(_piStore.size).toBe(0);
  });

  test("broadcasts for a conversation whose channel supports dynamic UI", async () => {
    // GIVEN the target conversation's channel renders dynamic UI
    registeredConversation = {
      channelCapabilities: { supportsDynamicUi: true },
    };

    // WHEN a standalone prompt is scoped to that conversation
    const promise = requestSecretStandalone({
      service: "stripe",
      field: "api_key",
      label: "Stripe API Key",
      conversationId: "conv-1",
    });

    // THEN the secret_request is broadcast
    expect(broadcastMessages).toHaveLength(1);
    expect(broadcastMessages[0]!.type).toBe("secret_request");

    // Settle the pending prompt so the test does not leak a timer.
    const entry = [..._piStore.values()][0];
    entry?.rpcResolve?.({ value: "v", delivery: "store" });
    await promise;
  });

  test("broadcasts for a conversation-less prompt (plain CLI invocation)", async () => {
    // WHEN a standalone prompt carries no conversationId
    const promise = requestSecretStandalone({
      service: "stripe",
      field: "api_key",
      label: "Stripe API Key",
    });

    // THEN the secret_request is broadcast (desktop/web clients render it)
    expect(broadcastMessages).toHaveLength(1);
    expect(broadcastMessages[0]!.type).toBe("secret_request");

    const entry = [..._piStore.values()][0];
    entry?.rpcResolve?.({ value: "v", delivery: "store" });
    await promise;
  });

  test("broadcasts when the conversation is not loaded in the registry", async () => {
    /**
     * A conversationId that resolves to no live conversation (e.g. the daemon
     * restarted between the CLI reading __CONVERSATION_ID and the prompt) must
     * not be treated as unsupported — the broadcast still reaches any
     * connected desktop/web client.
     */
    // GIVEN no conversation is registered for the id
    registeredConversation = undefined;

    // WHEN a standalone prompt is scoped to the unknown conversation
    const promise = requestSecretStandalone({
      service: "stripe",
      field: "api_key",
      label: "Stripe API Key",
      conversationId: "conv-1",
    });

    // THEN the secret_request is broadcast
    expect(broadcastMessages).toHaveLength(1);

    const entry = [..._piStore.values()][0];
    entry?.rpcResolve?.({ value: "v", delivery: "store" });
    await promise;
  });
});
