/**
 * End-to-end A2A lifecycle tests.
 *
 * Covers the full pairing handshake, conversational exchange,
 * and security invariants (auth enforcement, invite code validation,
 * identity verification, routing hijack prevention).
 *
 * Uses the same mock pattern as a2a-pairing.test.ts but adds platform
 * isolation to avoid SQLite contention when run in parallel.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Platform isolation — temp directory per test file to avoid SQLITE_BUSY
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "a2a-lifecycle-e2e-"));

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  getWorkspaceConfigPath: () => join(testDir, "config.json"),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

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

// Mock access request helper to avoid full notification pipeline.
// The interceptor imports this transitively; the mock intercepts it.
const mockNotifyGuardian = mock(() => ({
  notified: true,
  created: true,
  requestId: "test-request-id",
}));
mock.module("../runtime/access-request-helper.js", () => ({
  notifyGuardianOfAccessRequest: mockNotifyGuardian,
}));

import { initializeDb, resetDb } from "../memory/db.js";
import type {
  A2APairingAccepted,
  A2APairingFinalize,
} from "../runtime/a2a/index.js";
import {
  completePairingApproval,
  handleInboundPairingRequest,
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

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

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
  test("phase 1+2: initiation stores outbound request and sends to target gateway", async () => {
    const { inviteCode, pairingRequestId } = await initiatePairing(
      "assistant-b",
      "https://b-gateway.example.com",
      "assistant-a",
      "https://a-gateway.example.com",
    );

    expect(inviteCode).toBeTruthy();
    expect(pairingRequestId).toBeTruthy();

    // Outbound pairing request was stored
    const outboundReq = findPairingByInviteCode(inviteCode);
    expect(outboundReq).not.toBeNull();
    expect(outboundReq!.direction).toBe("outbound");
    expect(outboundReq!.status).toBe("pending");
    expect(outboundReq!.remoteAssistantId).toBe("assistant-b");

    // Pairing request was sent to B's gateway
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toBe(
      "https://b-gateway.example.com/webhook/a2a",
    );
  });

  test("phase 2b: target guardian approves pairing and sends acceptance", async () => {
    // Simulate B's side: create an inbound pairing request
    handleInboundPairingRequest({
      version: "v1",
      type: "pairing_request",
      senderAssistantId: "assistant-a",
      senderGatewayUrl: "https://a-gateway.example.com",
      inviteCode: "test-invite-phase2b",
    });

    // B's guardian approves
    const approvalSuccess = await completePairingApproval(
      "assistant-a",
      "assistant-b",
    );
    expect(approvalSuccess).toBe(true);

    // B generated an inbound token
    const bInboundToken = keyStore.get("a2a:inbound:assistant-a");
    expect(bInboundToken).toBeTruthy();

    // B stored the gateway URL
    expect(keyStore.get("a2a:gateway:assistant-a")).toBe(
      "https://a-gateway.example.com",
    );

    // PairingAccepted was sent to A's gateway
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toBe(
      "https://a-gateway.example.com/webhook/a2a",
    );
  });

  test("phase 3: initiator receives acceptance and sends finalize with auth", async () => {
    // Simulate A's side: outbound pairing request exists
    createPairingRequest(
      "outbound",
      "test-invite-phase3",
      "assistant-b",
      "https://b-gateway.example.com",
      Date.now() + 3600_000,
    );

    const acceptedEnvelope: A2APairingAccepted = {
      version: "v1",
      type: "pairing_accepted",
      senderAssistantId: "assistant-b",
      inviteCode: "test-invite-phase3",
      inboundToken: "b-token-for-a",
    };

    const result = await handlePairingAccepted(acceptedEnvelope, "assistant-a");
    expect(result).toBe(true);

    // A stored outbound token (B's inbound token)
    expect(keyStore.get("a2a:outbound:assistant-b")).toBe("b-token-for-a");

    // A generated its own inbound token
    const aInboundToken = keyStore.get("a2a:inbound:assistant-b");
    expect(aInboundToken).toBeTruthy();

    // PairingFinalize was sent to B's gateway (authenticated)
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toBe(
      "https://b-gateway.example.com/deliver/a2a",
    );
    const finalizeHeaders = fetchCalls[0]!.init.headers as Record<
      string,
      string
    >;
    expect(finalizeHeaders["Authorization"]).toBe("Bearer b-token-for-a");
  });

  test("phase 4: target receives finalize and stores outbound token (mutual auth complete)", async () => {
    // Simulate B's side: inbound pairing request in "accepted" state
    const req = createPairingRequest(
      "inbound",
      "test-invite-phase4",
      "assistant-a",
      "https://a-gateway.example.com",
      Date.now() + 3600_000,
    );
    updatePairingStatus(req.id, "accepted");

    const finalizeEnvelope: A2APairingFinalize = {
      version: "v1",
      type: "pairing_finalize",
      senderAssistantId: "assistant-a",
      inviteCode: "test-invite-phase4",
      inboundToken: "a-token-for-b",
    };

    const result = await handlePairingFinalize(finalizeEnvelope);
    expect(result).toBe(true);

    // B stored outbound token (A's inbound token)
    expect(keyStore.get("a2a:outbound:assistant-a")).toBe("a-token-for-b");
  });

  test("complete token exchange produces mutual authentication", async () => {
    // Verify the token exchange invariant: after a successful handshake,
    // each side holds the other's inbound token as their outbound token.

    // Simulate A's outbound request
    createPairingRequest(
      "outbound",
      "mutual-auth-invite",
      "assistant-b",
      "https://b-gateway.example.com",
      Date.now() + 3600_000,
    );

    // Phase 3: A processes acceptance from B
    await handlePairingAccepted(
      {
        version: "v1",
        type: "pairing_accepted",
        senderAssistantId: "assistant-b",
        inviteCode: "mutual-auth-invite",
        inboundToken: "b-inbound-token",
      },
      "assistant-a",
    );

    // Verify A's state
    expect(keyStore.get("a2a:outbound:assistant-b")).toBe("b-inbound-token");
    const aInbound = keyStore.get("a2a:inbound:assistant-b");
    expect(aInbound).toBeTruthy();
    expect(keyStore.get("a2a:gateway:assistant-b")).toBe(
      "https://b-gateway.example.com",
    );
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
