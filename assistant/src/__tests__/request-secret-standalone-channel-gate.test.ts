/**
 * Verifies the channel gate in `requestSecretStandalone`: a prompt scoped to
 * a conversation whose channel cannot render dynamic UI (slack, telegram, …)
 * must resolve immediately with `unsupported_channel` instead of broadcasting
 * a `secret_request` that no surface can render — which would otherwise sit
 * pending until it times out and get misreported as a user cancellation.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ServerMessage } from "../daemon/message-protocol.js";
import { setConfig } from "./helpers/set-config.js";

// A short permission timeout keeps a leaked prompt from lingering; the default
// `secretDetection.allowOneTimeSend` (false) drives the broadcast field.
setConfig("timeouts", { permissionTimeoutSec: 0.01 });

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

// Controls the gateway mint result for the collection-link fallback.
let gatewayMintResult: unknown;
let gatewayMintCalls: Array<{ method: string; params: unknown }> = [];
mock.module("../ipc/gateway-client.js", () => ({
  ipcCall: async (method: string, params?: unknown) => {
    gatewayMintCalls.push({ method, params });
    return gatewayMintResult;
  },
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
    gatewayMintResult = undefined;
    gatewayMintCalls = [];
  });

  test("short-circuits with unsupported_channel for a non-dynamic-UI conversation", async () => {
    // GIVEN the target conversation's channel cannot render dynamic UI and
    // the gateway cannot mint a collection link (unreachable)
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
    expect(result.collectionUrl).toBeUndefined();
    expect(broadcastMessages).toHaveLength(0);
    expect(_piStore.size).toBe(0);
  });

  test("returns a one-time collection link when the gateway can mint one", async () => {
    // GIVEN a non-dynamic-UI conversation and a gateway that mints links
    registeredConversation = {
      channelCapabilities: { supportsDynamicUi: false },
    };
    gatewayMintResult = {
      ok: true,
      token: "tok",
      url: "https://x.test/assistant/credentials/enter?token=tok",
      expiresAt: 1234,
    };

    // WHEN a standalone prompt is scoped to that conversation
    const result = await requestSecretStandalone({
      service: "stripe",
      field: "api_key",
      label: "Stripe API Key",
      conversationId: "conv-1",
    });

    // THEN the result carries the link (still no broadcast, nothing pending)
    expect(result.value).toBeNull();
    expect(result.error).toBe("unsupported_channel");
    expect(result.collectionUrl).toBe(
      "https://x.test/assistant/credentials/enter?token=tok",
    );
    expect(result.collectionExpiresAt).toBe(1234);
    expect(broadcastMessages).toHaveLength(0);
    expect(_piStore.size).toBe(0);
    expect(gatewayMintCalls).toEqual([
      {
        method: "create_credential_request",
        params: {
          service: "stripe",
          field: "api_key",
          label: "Stripe API Key",
        },
      },
    ]);
  });

  test("carries the credential policy onto the gateway row at mint time", async () => {
    // GIVEN a non-dynamic-UI conversation and a prompt carrying policy
    registeredConversation = {
      channelCapabilities: { supportsDynamicUi: false },
    };
    gatewayMintResult = {
      ok: true,
      token: "tok",
      url: "https://x.test/assistant/credentials/enter#token=tok",
      expiresAt: 1234,
    };

    // WHEN the standalone prompt carries policy fields
    await requestSecretStandalone({
      service: "stripe",
      field: "api_key",
      label: "Stripe API Key",
      purpose: "Billing lookups",
      allowedTools: ["make_authenticated_request"],
      allowedDomains: ["api.stripe.com"],
      injectionTemplates: [
        { hostPattern: "api.stripe.com", injectionType: "header" },
      ],
      conversationId: "conv-1",
    });

    // THEN the mint call carries the policy as JSON for the gateway row
    expect(gatewayMintCalls).toHaveLength(1);
    const params = gatewayMintCalls[0]!.params as { policyJson?: string };
    expect(JSON.parse(params.policyJson ?? "{}")).toEqual({
      usageDescription: "Billing lookups",
      allowedTools: ["make_authenticated_request"],
      allowedDomains: ["api.stripe.com"],
      injectionTemplates: [
        { hostPattern: "api.stripe.com", injectionType: "header" },
      ],
    });
  });

  test("falls back to a plain unsupported_channel when minting is refused", async () => {
    // GIVEN the gateway refuses to mint (flag off / no public URL)
    registeredConversation = {
      channelCapabilities: { supportsDynamicUi: false },
    };
    gatewayMintResult = { ok: false, error: "flag_disabled" };

    // WHEN a standalone prompt is scoped to that conversation
    const result = await requestSecretStandalone({
      service: "stripe",
      field: "api_key",
      label: "Stripe API Key",
      conversationId: "conv-1",
    });

    // THEN the plain unsupported_channel failure stands
    expect(result.error).toBe("unsupported_channel");
    expect(result.collectionUrl).toBeUndefined();
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
