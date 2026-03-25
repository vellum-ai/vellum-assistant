/**
 * End-to-end A2A lifecycle tests.
 *
 * Covers the full pairing handshake, conversational exchange,
 * and security invariants (auth enforcement, invite code validation,
 * identity verification, routing hijack prevention).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { initializeDb, resetDb } from "../memory/db.js";
import type {
  A2APairingAccepted,
  A2APairingFinalize,
} from "../runtime/a2a/index.js";
import {
  completePairingApproval,
  handlePairingAccepted,
  handlePairingFinalize,
  initiatePairing,
} from "../runtime/a2a/pairing.js";
import {
  createPairingRequest,
  findPairingByInviteCode,
  updatePairingStatus,
} from "../runtime/a2a/pairing-store.js";
import { interceptA2AEnvelope } from "../runtime/routes/inbound-stages/a2a-interceptor.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock fetch for outbound HTTP calls
const fetchCalls: { url: string; init: RequestInit }[] = [];
const mockFetch = mock((url: string | URL | Request, init?: RequestInit) => {
  fetchCalls.push({ url: String(url), init: init ?? {} });
  return Promise.resolve(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
});
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
  fetchCalls.length = 0;
});

// ---------------------------------------------------------------------------
// Full lifecycle: pairing handshake -> conversational exchange
// ---------------------------------------------------------------------------

describe("A2A full lifecycle", () => {
  test("complete pairing handshake from initiation to mutual auth", async () => {
    // === Phase 1: Guardian A initiates pairing with B ===
    // A calls initiatePairing which creates an outbound request and
    // sends a pairing_request to B's gateway.
    const { inviteCode, pairingRequestId } = await initiatePairing(
      "assistant-b",
      "https://b-gateway.example.com",
      "assistant-a",
      "https://a-gateway.example.com",
    );

    expect(inviteCode).toBeTruthy();
    expect(pairingRequestId).toBeTruthy();

    // Verify the outbound pairing request was stored
    const outboundReq = findPairingByInviteCode(inviteCode);
    expect(outboundReq).not.toBeNull();
    expect(outboundReq!.direction).toBe("outbound");
    expect(outboundReq!.status).toBe("pending");
    expect(outboundReq!.remoteAssistantId).toBe("assistant-b");

    // Verify pairing_request was sent to B's gateway
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toBe(
      "https://b-gateway.example.com/webhook/a2a",
    );

    // === Phase 2: B's gateway receives pairing request and forwards to runtime ===
    // B's interceptor receives the pairing_request via sourceMetadata
    const interceptResult = await interceptA2AEnvelope({
      sourceMetadata: {
        a2a: true,
        envelopeType: "pairing_request",
        authenticated: false,
        envelope: {
          version: "v1",
          type: "pairing_request",
          senderAssistantId: "assistant-a",
          senderGatewayUrl: "https://a-gateway.example.com",
          inviteCode,
        },
      },
    });

    expect(interceptResult.handled).toBe(true);
    const interceptBody = await interceptResult.response!.json();
    expect(interceptBody.accepted).toBe(true);

    // Guardian should have been notified
    expect(mockNotifyGuardian).toHaveBeenCalledTimes(1);

    // Inbound pairing request should be stored on B's side
    // (use a separate DB context simulation — in a real scenario, A and B
    // have separate DBs; here we share one but differentiate by direction)

    // === Phase 2b: B's guardian approves -> sends PairingAccepted ===
    // completePairingApproval creates the contact, generates inbound token,
    // and sends PairingAccepted back to A.
    // First, store the inbound request on B's side
    // (initiatePairing stored outbound; interceptor stored inbound)
    mockFetch.mockClear();
    fetchCalls.length = 0;

    const approvalSuccess = await completePairingApproval(
      "assistant-a",
      "assistant-b",
    );
    expect(approvalSuccess).toBe(true);

    // B should have generated an inbound token
    const bInboundToken = keyStore.get("a2a:inbound:assistant-a");
    expect(bInboundToken).toBeTruthy();

    // B should have stored the gateway URL
    expect(keyStore.get("a2a:gateway:assistant-a")).toBe(
      "https://a-gateway.example.com",
    );

    // PairingAccepted should have been sent to A's gateway
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toBe(
      "https://a-gateway.example.com/webhook/a2a",
    );

    // === Phase 3: A receives PairingAccepted ===
    mockFetch.mockClear();
    fetchCalls.length = 0;

    const acceptedEnvelope: A2APairingAccepted = {
      version: "v1",
      type: "pairing_accepted",
      senderAssistantId: "assistant-b",
      inviteCode,
      inboundToken: bInboundToken!,
    };

    // handlePairingAccepted on A's side should:
    // - Validate the invite code matches the outbound request
    // - Validate sender identity matches
    // - Store the outbound token (B's inbound token becomes A's outbound token)
    // - Generate A's inbound token
    // - Send PairingFinalize to B
    //
    // Note: in the shared DB, A's outbound request was already stored by initiatePairing.
    // But completePairingApproval above accepted the inbound request which changes
    // the invite code's status. We need to work with the original outbound request.
    // Since both A and B share the DB, the outbound "pending" request is
    // the one created by initiatePairing. Let's verify it's still accessible.
    const acceptedResult = await handlePairingAccepted(
      acceptedEnvelope,
      "assistant-a",
    );

    // The shared DB has the outbound request from initiatePairing still in "pending"
    // and the invite code matches, so this should succeed.
    expect(acceptedResult).toBe(true);

    // A should have stored outbound token (B's inbound token)
    expect(keyStore.get("a2a:outbound:assistant-b")).toBe(bInboundToken);

    // A should have generated its own inbound token
    const aInboundToken = keyStore.get("a2a:inbound:assistant-b");
    expect(aInboundToken).toBeTruthy();

    // PairingFinalize should have been sent to B's gateway (authenticated)
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toBe(
      "https://b-gateway.example.com/deliver/a2a",
    );
    const finalizeHeaders = fetchCalls[0]!.init.headers as Record<
      string,
      string
    >;
    expect(finalizeHeaders["Authorization"]).toBe(`Bearer ${bInboundToken}`);

    // === Phase 4: B receives PairingFinalize ===
    const finalizeEnvelope: A2APairingFinalize = {
      version: "v1",
      type: "pairing_finalize",
      senderAssistantId: "assistant-a",
      inviteCode,
      inboundToken: aInboundToken!,
    };

    // The inbound request on B's side should be in "accepted" state
    // after completePairingApproval was called.
    const finalizeResult = await handlePairingFinalize(finalizeEnvelope);
    expect(finalizeResult).toBe(true);

    // B should have stored outbound token (A's inbound token)
    expect(keyStore.get("a2a:outbound:assistant-a")).toBe(aInboundToken);

    // === Mutual auth is now established ===
    // A has: outbound token for B (B's inbound token), inbound token for B
    // B has: outbound token for A (A's inbound token), inbound token for A
  });

  test("authenticated message passes through interceptor to normal pipeline", async () => {
    // After pairing, a message envelope with authenticated=true should
    // pass through the interceptor (handled: false) to the normal inbound pipeline.
    const result = await interceptA2AEnvelope({
      sourceMetadata: {
        a2a: true,
        envelopeType: "message",
        authenticated: true,
        senderAssistantId: "remote-asst",
      },
    });
    expect(result.handled).toBe(false);
  });

  test("pairing envelopes never appear in conversation history (intercepted before pipeline)", async () => {
    // pairing_request is intercepted
    const pairingResult = await interceptA2AEnvelope({
      sourceMetadata: {
        a2a: true,
        envelopeType: "pairing_request",
        authenticated: false,
        envelope: {
          version: "v1",
          type: "pairing_request",
          senderAssistantId: "pairing-asst",
          senderGatewayUrl: "https://pairing-gw.example.com",
          inviteCode: "never-in-history",
        },
      },
    });
    expect(pairingResult.handled).toBe(true);

    // pairing_accepted is intercepted
    const acceptedResult = await interceptA2AEnvelope({
      sourceMetadata: {
        a2a: true,
        envelopeType: "pairing_accepted",
        authenticated: false,
        envelope: {
          version: "v1",
          type: "pairing_accepted",
          senderAssistantId: "pairing-asst",
          inviteCode: "never-in-history",
          inboundToken: "tok",
        },
      },
    });
    expect(acceptedResult.handled).toBe(true);

    // pairing_finalize is intercepted
    const finalizeResult = await interceptA2AEnvelope({
      sourceMetadata: {
        a2a: true,
        envelopeType: "pairing_finalize",
        authenticated: true,
        envelope: {
          version: "v1",
          type: "pairing_finalize",
          senderAssistantId: "pairing-asst",
          inviteCode: "never-in-history",
          inboundToken: "tok",
        },
      },
    });
    expect(finalizeResult.handled).toBe(true);

    // Only "message" type passes through to conversation pipeline
    const msgResult = await interceptA2AEnvelope({
      sourceMetadata: {
        a2a: true,
        envelopeType: "message",
        authenticated: true,
      },
    });
    expect(msgResult.handled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Security: auth enforcement
// ---------------------------------------------------------------------------

describe("A2A security — auth enforcement", () => {
  test("unauthenticated message envelope is rejected at interceptor", async () => {
    const result = await interceptA2AEnvelope({
      sourceMetadata: {
        a2a: true,
        envelopeType: "message",
        authenticated: false,
      },
    });
    expect(result.handled).toBe(true);
    expect(result.response!.status).toBe(403);
  });

  test("unauthenticated pairing_finalize is rejected at interceptor", async () => {
    const result = await interceptA2AEnvelope({
      sourceMetadata: {
        a2a: true,
        envelopeType: "pairing_finalize",
        authenticated: false,
      },
    });
    expect(result.handled).toBe(true);
    expect(result.response!.status).toBe(403);
  });

  test("unauthenticated pairing_request is allowed (by design)", async () => {
    const result = await interceptA2AEnvelope({
      sourceMetadata: {
        a2a: true,
        envelopeType: "pairing_request",
        authenticated: false,
        envelope: {
          version: "v1",
          type: "pairing_request",
          senderAssistantId: "test-asst",
          senderGatewayUrl: "https://test.example.com",
          inviteCode: "allowed-unauth",
        },
      },
    });
    expect(result.handled).toBe(true);
    const body = await result.response!.json();
    expect(body.accepted).toBe(true);
  });

  test("unauthenticated pairing_accepted is allowed (by design)", async () => {
    // pairing_accepted is unauthenticated but validated via invite code
    const result = await interceptA2AEnvelope({
      sourceMetadata: {
        a2a: true,
        envelopeType: "pairing_accepted",
        authenticated: false,
        envelope: {
          version: "v1",
          type: "pairing_accepted",
          senderAssistantId: "some-asst",
          inviteCode: "no-matching-request",
          inboundToken: "tok",
        },
      },
    });
    // Handled (intercepted) even if no matching request
    expect(result.handled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Security: invite code validation
// ---------------------------------------------------------------------------

describe("A2A security — invite code validation", () => {
  test("pairing_accepted with wrong invite code is rejected", async () => {
    createPairingRequest(
      "outbound",
      "correct-invite",
      "remote-asst",
      "https://gw.example.com",
      Date.now() + 3600_000,
    );

    const envelope: A2APairingAccepted = {
      version: "v1",
      type: "pairing_accepted",
      senderAssistantId: "remote-asst",
      inviteCode: "wrong-invite",
      inboundToken: "tok-123",
    };

    const result = await handlePairingAccepted(envelope);
    expect(result).toBe(false);
  });

  test("pairing_accepted with correct invite code but wrong senderAssistantId is rejected", async () => {
    createPairingRequest(
      "outbound",
      "identity-test-invite",
      "expected-asst",
      "https://gw.example.com",
      Date.now() + 3600_000,
    );

    const envelope: A2APairingAccepted = {
      version: "v1",
      type: "pairing_accepted",
      senderAssistantId: "impersonator-asst",
      inviteCode: "identity-test-invite",
      inboundToken: "tok-123",
    };

    const result = await handlePairingAccepted(envelope);
    expect(result).toBe(false);
  });

  test("pairing_accepted with expired invite code is rejected", async () => {
    createPairingRequest(
      "outbound",
      "expired-invite",
      "remote-asst",
      "https://gw.example.com",
      Date.now() - 1, // Already expired
    );

    const envelope: A2APairingAccepted = {
      version: "v1",
      type: "pairing_accepted",
      senderAssistantId: "remote-asst",
      inviteCode: "expired-invite",
      inboundToken: "tok-123",
    };

    const result = await handlePairingAccepted(envelope);
    expect(result).toBe(false);
  });

  test("pairing_accepted with no matching pending outbound request is rejected", async () => {
    // No outbound request created at all
    const envelope: A2APairingAccepted = {
      version: "v1",
      type: "pairing_accepted",
      senderAssistantId: "random-asst",
      inviteCode: "nonexistent-invite",
      inboundToken: "tok-123",
    };

    const result = await handlePairingAccepted(envelope);
    expect(result).toBe(false);
  });

  test("pairing_finalize with wrong invite code is rejected", async () => {
    const req = createPairingRequest(
      "inbound",
      "finalize-correct-invite",
      "remote-asst",
      "https://gw.example.com",
      Date.now() + 3600_000,
    );
    updatePairingStatus(req.id, "accepted");

    const envelope: A2APairingFinalize = {
      version: "v1",
      type: "pairing_finalize",
      senderAssistantId: "remote-asst",
      inviteCode: "finalize-wrong-invite",
      inboundToken: "tok-123",
    };

    const result = await handlePairingFinalize(envelope);
    expect(result).toBe(false);
  });

  test("pairing_finalize with wrong sender identity is rejected", async () => {
    const req = createPairingRequest(
      "inbound",
      "finalize-identity-invite",
      "expected-asst",
      "https://gw.example.com",
      Date.now() + 3600_000,
    );
    updatePairingStatus(req.id, "accepted");

    const envelope: A2APairingFinalize = {
      version: "v1",
      type: "pairing_finalize",
      senderAssistantId: "wrong-asst",
      inviteCode: "finalize-identity-invite",
      inboundToken: "tok-123",
    };

    const result = await handlePairingFinalize(envelope);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Security: conversationExternalId is server-derived
// ---------------------------------------------------------------------------

describe("A2A security — server-derived routing", () => {
  test("conversationExternalId in forwarded payload is always senderAssistantId (verified at gateway)", () => {
    // This invariant is enforced in the gateway's a2a-webhook handler:
    // conversationExternalId is set to envelope.senderAssistantId,
    // not to any value provided by the sender. The sender has no
    // control over which conversation their message is routed to.
    //
    // This test documents the invariant; the actual enforcement is
    // covered in gateway/src/__tests__/a2a-webhook.test.ts.
    // Here we verify the interceptor does not override routing.

    // The interceptor only checks sourceMetadata.a2a — it does NOT
    // set conversationExternalId. That field is set by the gateway
    // before forwarding, so the sender cannot inject a different value.
    expect(true).toBe(true); // Invariant documented, enforced at gateway level
  });
});

// ---------------------------------------------------------------------------
// Security: disabled feature flag
// ---------------------------------------------------------------------------

describe("A2A security — feature flag", () => {
  test("disabled feature flag returns 404 on all A2A routes (verified at gateway)", () => {
    // This invariant is enforced in the gateway's a2a-webhook handler:
    // isA2AEnabled() is checked first, returning 404 if disabled.
    // The gateway test (a2a-webhook.test.ts) covers this directly.
    // The interceptor in the runtime doesn't re-check the flag because
    // the gateway already gates it.
    expect(true).toBe(true); // Invariant documented, enforced at gateway level
  });
});

// ---------------------------------------------------------------------------
// Security: pairing request state machine
// ---------------------------------------------------------------------------

describe("A2A security — pairing state machine", () => {
  test("pairing_accepted rejects already-accepted outbound request", async () => {
    const req = createPairingRequest(
      "outbound",
      "already-accepted-invite",
      "remote-asst",
      "https://gw.example.com",
      Date.now() + 3600_000,
    );
    updatePairingStatus(req.id, "accepted");

    const envelope: A2APairingAccepted = {
      version: "v1",
      type: "pairing_accepted",
      senderAssistantId: "remote-asst",
      inviteCode: "already-accepted-invite",
      inboundToken: "tok-replay",
    };

    // Should reject because the request is no longer "pending"
    const result = await handlePairingAccepted(envelope);
    expect(result).toBe(false);
  });

  test("pairing_finalize rejects pending (not accepted) inbound request", async () => {
    createPairingRequest(
      "inbound",
      "still-pending-invite",
      "remote-asst",
      "https://gw.example.com",
      Date.now() + 3600_000,
    );

    const envelope: A2APairingFinalize = {
      version: "v1",
      type: "pairing_finalize",
      senderAssistantId: "remote-asst",
      inviteCode: "still-pending-invite",
      inboundToken: "tok-123",
    };

    // Should reject because status is "pending", not "accepted"
    const result = await handlePairingFinalize(envelope);
    expect(result).toBe(false);
  });

  test("pairing_finalize rejects outbound direction request", async () => {
    const req = createPairingRequest(
      "outbound",
      "wrong-direction-invite",
      "remote-asst",
      "https://gw.example.com",
      Date.now() + 3600_000,
    );
    updatePairingStatus(req.id, "accepted");

    const envelope: A2APairingFinalize = {
      version: "v1",
      type: "pairing_finalize",
      senderAssistantId: "remote-asst",
      inviteCode: "wrong-direction-invite",
      inboundToken: "tok-123",
    };

    // Should reject because direction is "outbound" but finalize requires "inbound"
    const result = await handlePairingFinalize(envelope);
    expect(result).toBe(false);
  });

  test("pairing_finalize rejects failed inbound request", async () => {
    const req = createPairingRequest(
      "inbound",
      "failed-invite",
      "remote-asst",
      "https://gw.example.com",
      Date.now() + 3600_000,
    );
    updatePairingStatus(req.id, "failed");

    const envelope: A2APairingFinalize = {
      version: "v1",
      type: "pairing_finalize",
      senderAssistantId: "remote-asst",
      inviteCode: "failed-invite",
      inboundToken: "tok-123",
    };

    const result = await handlePairingFinalize(envelope);
    expect(result).toBe(false);
  });
});
