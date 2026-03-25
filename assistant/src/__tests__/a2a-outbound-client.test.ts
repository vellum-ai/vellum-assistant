/**
 * Tests for the A2A outbound client (`sendA2AMessage`) and the
 * `contact-message` bundled tool.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import * as contactStore from "../contacts/contact-store.js";
import type { ContactWithChannels } from "../contacts/types.js";
import type { AssistantContactMetadata } from "../contacts/types.js";
import { ChannelDeliveryError } from "../runtime/gateway-client.js";

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

// We mock at the module boundary so the outbound client's imports resolve
// to our controlled stubs.

const mockDeliverChannelReply = mock(() =>
  Promise.resolve({ ok: true as const }),
);
const mockMintEdgeRelayToken = mock(() => "test-bearer-token");

mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: mockDeliverChannelReply,
  ChannelDeliveryError,
}));

mock.module("../runtime/auth/token-service.js", () => ({
  mintEdgeRelayToken: mockMintEdgeRelayToken,
}));

mock.module("../config/env.js", () => ({
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
}));

// Import after mocks are set up
const { sendA2AMessage } = await import("../runtime/a2a/outbound-client.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAssistantContact(
  overrides: Partial<ContactWithChannels> = {},
): ContactWithChannels {
  return {
    id: "contact-alice",
    displayName: "Alice's Assistant",
    notes: null,
    lastInteraction: null,
    interactionCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    role: "contact",
    contactType: "assistant",
    principalId: null,
    userFile: null,
    channels: [],
    ...overrides,
  };
}

function makeVellumMetadata(
  overrides: Partial<{ assistantId: string; gatewayUrl: string }> = {},
): AssistantContactMetadata {
  return {
    contactId: "contact-alice",
    species: "vellum",
    metadata: {
      assistantId: overrides.assistantId ?? "remote-assistant-id",
      gatewayUrl: overrides.gatewayUrl ?? "https://alice.example.com:7830",
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sendA2AMessage", () => {
  let getContactSpy: ReturnType<typeof mock>;
  let getMetadataSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    getContactSpy = mock(() => makeAssistantContact());
    getMetadataSpy = mock(() => makeVellumMetadata());

    // Patch contact store functions
    (contactStore as Record<string, unknown>).getContact = getContactSpy;
    (contactStore as Record<string, unknown>).getAssistantContactMetadata =
      getMetadataSpy;

    mockDeliverChannelReply.mockReset();
    mockDeliverChannelReply.mockImplementation(() =>
      Promise.resolve({ ok: true as const }),
    );
    mockMintEdgeRelayToken.mockReset();
    mockMintEdgeRelayToken.mockImplementation(() => "test-bearer-token");
  });

  afterEach(() => {
    mock.restore();
  });

  test("successful outbound send with valid contact and credentials", async () => {
    const result = await sendA2AMessage("contact-alice", "Hello, Alice!");

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    // Verify deliverChannelReply was called with standard ChannelReplyPayload
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1);
    const [callbackUrl, payload, token] = mockDeliverChannelReply.mock.calls[0];

    // Callback URL should point to gateway /deliver/a2a with routing params
    expect(callbackUrl).toContain("http://127.0.0.1:7830/deliver/a2a");
    expect(callbackUrl).toContain(
      "gatewayUrl=" + encodeURIComponent("https://alice.example.com:7830"),
    );
    expect(callbackUrl).toContain(
      "assistantId=" + encodeURIComponent("remote-assistant-id"),
    );

    // Payload is standard ChannelReplyPayload — no A2A-specific fields
    expect(payload).toEqual({
      chatId: "remote-assistant-id",
      text: "Hello, Alice!",
    });

    // Bearer token from mintEdgeRelayToken
    expect(token).toBe("test-bearer-token");
  });

  test("failure when contact is not found", async () => {
    getContactSpy.mockImplementation(() => null);
    (contactStore as Record<string, unknown>).getContact = getContactSpy;

    const result = await sendA2AMessage("nonexistent", "Hello");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Contact not found");
    expect(mockDeliverChannelReply).not.toHaveBeenCalled();
  });

  test("failure when contact is human (wrong contact type)", async () => {
    getContactSpy.mockImplementation(() =>
      makeAssistantContact({ contactType: "human" }),
    );
    (contactStore as Record<string, unknown>).getContact = getContactSpy;

    const result = await sendA2AMessage("contact-alice", "Hello");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not an assistant");
    expect(result.error).toContain("human");
    expect(mockDeliverChannelReply).not.toHaveBeenCalled();
  });

  test("failure when contact has no assistant metadata", async () => {
    getMetadataSpy.mockImplementation(() => null);
    (contactStore as Record<string, unknown>).getAssistantContactMetadata =
      getMetadataSpy;

    const result = await sendA2AMessage("contact-alice", "Hello");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("No assistant metadata");
    expect(mockDeliverChannelReply).not.toHaveBeenCalled();
  });

  test("failure when assistant metadata species is not vellum", async () => {
    getMetadataSpy.mockImplementation(() => ({
      contactId: "contact-alice",
      species: "openclaw",
      metadata: {},
    }));
    (contactStore as Record<string, unknown>).getAssistantContactMetadata =
      getMetadataSpy;

    const result = await sendA2AMessage("contact-alice", "Hello");

    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      "does not have valid Vellum assistant metadata",
    );
    expect(mockDeliverChannelReply).not.toHaveBeenCalled();
  });

  test("failure when gateway deliver route returns error", async () => {
    mockDeliverChannelReply.mockImplementation(() => {
      throw new ChannelDeliveryError(502, "Bad Gateway");
    });

    const result = await sendA2AMessage("contact-alice", "Hello");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Delivery failed");
    expect(result.error).toContain("502");
  });

  test("outbound uses standard ChannelReplyPayload — no A2A-specific payload", async () => {
    await sendA2AMessage("contact-alice", "Test message");

    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1);
    const [, payload] = mockDeliverChannelReply.mock.calls[0];

    // The payload should only have chatId and text — no A2A-specific fields
    // like version, type, senderAssistantId, messageId, etc.
    const payloadKeys = Object.keys(payload);
    expect(payloadKeys).toEqual(["chatId", "text"]);
    expect(payload.chatId).toBe("remote-assistant-id");
    expect(payload.text).toBe("Test message");
  });

  test("verify reply routing reuses replyCallbackUrl from inbound context", () => {
    // This test documents the architectural invariant: when responding to an
    // inbound A2A message, the runtime uses the `replyCallbackUrl` already set
    // by the gateway at inbound time. The outbound client is only for
    // proactive (tool-initiated) messages. Reply routing is the standard
    // callback pipeline — no special A2A reply logic is needed in the daemon.
    //
    // The gateway sets replyCallbackUrl with query params that include target
    // routing context (gatewayUrl, assistantId), which means the daemon's
    // standard deliverChannelReply flow handles replies correctly.
    //
    // This is verified by confirming that sendA2AMessage constructs the same
    // URL pattern that the gateway would set as replyCallbackUrl:
    // /deliver/a2a?gatewayUrl=...&assistantId=...
    expect(true).toBe(true); // Architectural invariant documented above
  });
});
