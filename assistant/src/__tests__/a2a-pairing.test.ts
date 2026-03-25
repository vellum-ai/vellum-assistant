import { beforeEach, describe, expect, mock, test } from "bun:test";

import { initializeDb, resetDb } from "../memory/db.js";
import type {
  A2APairingAccepted,
  A2APairingFinalize,
} from "../runtime/a2a/message-contract.js";
import {
  handleInboundPairingRequest,
  handlePairingAccepted,
  handlePairingFinalize,
} from "../runtime/a2a/pairing.js";
import {
  createPairingRequest,
  findPairingByInviteCode,
  findPairingByRemoteAssistant,
  updatePairingStatus,
} from "../runtime/a2a/pairing-store.js";
import { interceptA2AEnvelope } from "../runtime/routes/inbound-stages/a2a-interceptor.js";

// Mock fetch for outbound HTTP calls
const mockFetch = mock(() =>
  Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
);
globalThis.fetch = mockFetch as unknown as typeof fetch;

// Mock secure key store — in-memory map for tests
const keyStore = new Map<string, string>();
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => keyStore.get(key),
  setSecureKeyAsync: async (key: string, value: string) => {
    keyStore.set(key, value);
    return true;
  },
  _resetBackend: () => {},
}));

// Mock access request helper to avoid full notification pipeline
const mockNotifyGuardian = mock(() => ({
  notified: true,
  created: true,
  requestId: "test-request-id",
}));
mock.module("../runtime/access-request-helper.js", () => ({
  notifyGuardianOfAccessRequest: mockNotifyGuardian,
}));

initializeDb();

beforeEach(() => {
  resetDb();
  initializeDb();
  keyStore.clear();
  mockFetch.mockClear();
  mockNotifyGuardian.mockClear();
});

// ---------------------------------------------------------------------------
// Pairing store CRUD
// ---------------------------------------------------------------------------

describe("pairing store", () => {
  test("createPairingRequest stores and retrieves by invite code", () => {
    const req = createPairingRequest(
      "outbound",
      "invite-abc",
      "remote-asst-1",
      "https://gw.example.com",
      Date.now() + 3600_000,
    );

    expect(req.direction).toBe("outbound");
    expect(req.status).toBe("pending");

    const found = findPairingByInviteCode("invite-abc");
    expect(found).not.toBeNull();
    expect(found!.remoteAssistantId).toBe("remote-asst-1");
  });

  test("findPairingByInviteCode returns null for unknown code", () => {
    expect(findPairingByInviteCode("nonexistent")).toBeNull();
  });

  test("findPairingByInviteCode auto-expires stale requests", () => {
    createPairingRequest(
      "outbound",
      "expired-code",
      "remote-asst-1",
      "https://gw.example.com",
      Date.now() - 1, // Already expired
    );

    expect(findPairingByInviteCode("expired-code")).toBeNull();
  });

  test("findPairingByRemoteAssistant returns matching request", () => {
    createPairingRequest(
      "inbound",
      "invite-xyz",
      "remote-asst-2",
      "https://gw2.example.com",
      Date.now() + 3600_000,
    );

    const found = findPairingByRemoteAssistant("remote-asst-2", "inbound");
    expect(found).not.toBeNull();
    expect(found!.inviteCode).toBe("invite-xyz");
  });

  test("findPairingByRemoteAssistant returns null for wrong direction", () => {
    createPairingRequest(
      "outbound",
      "invite-wrong-dir",
      "remote-asst-3",
      "https://gw2.example.com",
      Date.now() + 3600_000,
    );

    expect(findPairingByRemoteAssistant("remote-asst-3", "inbound")).toBeNull();
  });

  test("updatePairingStatus changes status", () => {
    const req = createPairingRequest(
      "outbound",
      "invite-status",
      "remote-asst",
      "https://gw.example.com",
      Date.now() + 3600_000,
    );

    updatePairingStatus(req.id, "accepted");
    const found = findPairingByInviteCode("invite-status");
    expect(found!.status).toBe("accepted");
  });

  test("duplicate pairing request replaces pending request", () => {
    createPairingRequest(
      "outbound",
      "invite-old",
      "remote-asst-1",
      "https://gw.example.com",
      Date.now() + 3600_000,
    );

    createPairingRequest(
      "outbound",
      "invite-new",
      "remote-asst-1",
      "https://gw.example.com",
      Date.now() + 3600_000,
    );

    // Old invite code should no longer be found
    expect(findPairingByInviteCode("invite-old")).toBeNull();

    // New invite code should be found
    const found = findPairingByInviteCode("invite-new");
    expect(found).not.toBeNull();
    expect(found!.remoteAssistantId).toBe("remote-asst-1");
  });
});

// ---------------------------------------------------------------------------
// Pairing protocol — handleInboundPairingRequest
// ---------------------------------------------------------------------------

describe("handleInboundPairingRequest", () => {
  test("stores inbound pairing request", () => {
    handleInboundPairingRequest({
      version: "v1",
      type: "pairing_request",
      senderAssistantId: "sender-asst",
      senderGatewayUrl: "https://sender-gw.example.com",
      inviteCode: "inbound-invite",
    });

    const found = findPairingByInviteCode("inbound-invite");
    expect(found).not.toBeNull();
    expect(found!.direction).toBe("inbound");
    expect(found!.remoteAssistantId).toBe("sender-asst");
    expect(found!.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Pairing protocol — handlePairingAccepted
// ---------------------------------------------------------------------------

describe("handlePairingAccepted", () => {
  test("rejects when no matching outbound request exists", async () => {
    const envelope: A2APairingAccepted = {
      version: "v1",
      type: "pairing_accepted",
      senderAssistantId: "remote-asst",
      inviteCode: "nonexistent-code",
      inboundToken: "tok-123",
    };

    const result = await handlePairingAccepted(envelope);
    expect(result).toBe(false);
  });

  test("rejects when invite code matches but sender identity mismatches", async () => {
    createPairingRequest(
      "outbound",
      "invite-mismatch",
      "expected-asst",
      "https://gw.example.com",
      Date.now() + 3600_000,
    );

    const envelope: A2APairingAccepted = {
      version: "v1",
      type: "pairing_accepted",
      senderAssistantId: "wrong-asst", // Does not match "expected-asst"
      inviteCode: "invite-mismatch",
      inboundToken: "tok-123",
    };

    const result = await handlePairingAccepted(envelope);
    expect(result).toBe(false);
  });

  test("rejects expired outbound request", async () => {
    createPairingRequest(
      "outbound",
      "invite-expired",
      "remote-asst",
      "https://gw.example.com",
      Date.now() - 1, // Already expired
    );

    const envelope: A2APairingAccepted = {
      version: "v1",
      type: "pairing_accepted",
      senderAssistantId: "remote-asst",
      inviteCode: "invite-expired",
      inboundToken: "tok-123",
    };

    const result = await handlePairingAccepted(envelope);
    expect(result).toBe(false);
  });

  test("succeeds with valid outbound request and matching sender", async () => {
    createPairingRequest(
      "outbound",
      "invite-valid",
      "remote-asst",
      "https://gw.example.com",
      Date.now() + 3600_000,
    );

    const envelope: A2APairingAccepted = {
      version: "v1",
      type: "pairing_accepted",
      senderAssistantId: "remote-asst",
      inviteCode: "invite-valid",
      inboundToken: "tok-from-target",
    };

    const result = await handlePairingAccepted(envelope);
    expect(result).toBe(true);

    // Should have stored outbound token
    expect(keyStore.get("a2a:outbound:remote-asst")).toBe("tok-from-target");
    // Should have generated inbound token
    expect(keyStore.get("a2a:inbound:remote-asst")).toBeTruthy();
    // Should have stored gateway URL from stored request (not envelope)
    expect(keyStore.get("a2a:gateway:remote-asst")).toBe(
      "https://gw.example.com",
    );

    // Should have sent pairing_finalize
    expect(mockFetch).toHaveBeenCalled();

    // Pairing request should be accepted
    const req = findPairingByInviteCode("invite-valid");
    expect(req!.status).toBe("accepted");
  });
});

// ---------------------------------------------------------------------------
// Pairing protocol — handlePairingFinalize
// ---------------------------------------------------------------------------

describe("handlePairingFinalize", () => {
  test("rejects when no matching inbound request exists", async () => {
    const envelope: A2APairingFinalize = {
      version: "v1",
      type: "pairing_finalize",
      senderAssistantId: "remote-asst",
      inviteCode: "nonexistent-code",
      inboundToken: "tok-123",
    };

    const result = await handlePairingFinalize(envelope);
    expect(result).toBe(false);
  });

  test("rejects when inbound request exists but is pending (not accepted)", async () => {
    createPairingRequest(
      "inbound",
      "invite-pending",
      "remote-asst",
      "https://gw.example.com",
      Date.now() + 3600_000,
    );
    // Status is "pending", but finalize requires "accepted"

    const envelope: A2APairingFinalize = {
      version: "v1",
      type: "pairing_finalize",
      senderAssistantId: "remote-asst",
      inviteCode: "invite-pending",
      inboundToken: "tok-123",
    };

    const result = await handlePairingFinalize(envelope);
    expect(result).toBe(false);
  });

  test("rejects when sender identity mismatches", async () => {
    const req = createPairingRequest(
      "inbound",
      "invite-fin-mismatch",
      "expected-asst",
      "https://gw.example.com",
      Date.now() + 3600_000,
    );
    updatePairingStatus(req.id, "accepted");

    const envelope: A2APairingFinalize = {
      version: "v1",
      type: "pairing_finalize",
      senderAssistantId: "wrong-asst",
      inviteCode: "invite-fin-mismatch",
      inboundToken: "tok-123",
    };

    const result = await handlePairingFinalize(envelope);
    expect(result).toBe(false);
  });

  test("succeeds with valid accepted inbound request", async () => {
    const req = createPairingRequest(
      "inbound",
      "invite-fin-valid",
      "remote-asst",
      "https://gw.example.com",
      Date.now() + 3600_000,
    );
    updatePairingStatus(req.id, "accepted");

    const envelope: A2APairingFinalize = {
      version: "v1",
      type: "pairing_finalize",
      senderAssistantId: "remote-asst",
      inviteCode: "invite-fin-valid",
      inboundToken: "tok-from-initiator",
    };

    const result = await handlePairingFinalize(envelope);
    expect(result).toBe(true);

    // Should have stored outbound token
    expect(keyStore.get("a2a:outbound:remote-asst")).toBe("tok-from-initiator");
  });
});

// ---------------------------------------------------------------------------
// A2A interceptor
// ---------------------------------------------------------------------------

describe("A2A interceptor", () => {
  test("passes through non-A2A metadata", async () => {
    const result = await interceptA2AEnvelope({
      sourceMetadata: { someOther: true },
    });
    expect(result.handled).toBe(false);
  });

  test("passes through undefined metadata", async () => {
    const result = await interceptA2AEnvelope({});
    expect(result.handled).toBe(false);
  });

  test("passes through message type to normal pipeline", async () => {
    const result = await interceptA2AEnvelope({
      sourceMetadata: {
        a2a: true,
        envelopeType: "message",
        authenticated: true,
      },
    });
    expect(result.handled).toBe(false);
  });

  test("rejects unauthenticated non-pairing envelopes", async () => {
    const result = await interceptA2AEnvelope({
      sourceMetadata: {
        a2a: true,
        envelopeType: "message",
        authenticated: false,
      },
    });
    expect(result.handled).toBe(true);
    expect(result.response?.status).toBe(403);
  });

  test("rejects unauthenticated pairing_finalize", async () => {
    const result = await interceptA2AEnvelope({
      sourceMetadata: {
        a2a: true,
        envelopeType: "pairing_finalize",
        authenticated: false,
      },
    });
    expect(result.handled).toBe(true);
    expect(result.response?.status).toBe(403);
  });

  test("handles pairing_request envelope", async () => {
    const result = await interceptA2AEnvelope({
      sourceMetadata: {
        a2a: true,
        envelopeType: "pairing_request",
        authenticated: false,
        envelope: {
          version: "v1",
          type: "pairing_request",
          senderAssistantId: "test-asst",
          senderGatewayUrl: "https://test-gw.example.com",
          inviteCode: "test-invite",
        },
      },
    });
    expect(result.handled).toBe(true);
    const body = await result.response!.json();
    expect(body.accepted).toBe(true);
    expect(body.type).toBe("pairing_request");

    // Should have stored the inbound pairing request
    const found = findPairingByInviteCode("test-invite");
    expect(found).not.toBeNull();
    expect(found!.direction).toBe("inbound");
  });

  test("handles unknown envelope type", async () => {
    const result = await interceptA2AEnvelope({
      sourceMetadata: {
        a2a: true,
        envelopeType: "unknown_type",
        authenticated: true,
      },
    });
    expect(result.handled).toBe(true);
    expect(result.response?.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Full handshake lifecycle (integration-style)
// ---------------------------------------------------------------------------

describe("full handshake lifecycle", () => {
  test("pairing envelopes never reach conversation pipeline", async () => {
    // pairing_request with a2a flag should be handled by interceptor
    const requestResult = await interceptA2AEnvelope({
      sourceMetadata: {
        a2a: true,
        envelopeType: "pairing_request",
        authenticated: false,
        envelope: {
          version: "v1",
          type: "pairing_request",
          senderAssistantId: "lifecycle-asst",
          senderGatewayUrl: "https://lifecycle-gw.example.com",
          inviteCode: "lifecycle-invite",
        },
      },
    });
    expect(requestResult.handled).toBe(true);

    // pairing_accepted should be handled
    const acceptedResult = await interceptA2AEnvelope({
      sourceMetadata: {
        a2a: true,
        envelopeType: "pairing_accepted",
        authenticated: false,
        envelope: {
          version: "v1",
          type: "pairing_accepted",
          senderAssistantId: "other-asst",
          inviteCode: "some-code",
          inboundToken: "tok-123",
        },
      },
    });
    expect(acceptedResult.handled).toBe(true);

    // pairing_finalize should be handled (when authenticated)
    const finalizeResult = await interceptA2AEnvelope({
      sourceMetadata: {
        a2a: true,
        envelopeType: "pairing_finalize",
        authenticated: true,
        envelope: {
          version: "v1",
          type: "pairing_finalize",
          senderAssistantId: "other-asst",
          inviteCode: "some-code",
          inboundToken: "tok-456",
        },
      },
    });
    expect(finalizeResult.handled).toBe(true);

    // Only "message" passes through
    const messageResult = await interceptA2AEnvelope({
      sourceMetadata: {
        a2a: true,
        envelopeType: "message",
        authenticated: true,
      },
    });
    expect(messageResult.handled).toBe(false);
  });
});
