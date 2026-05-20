/**
 * Tests for the self-hosted A2A invite accept broker (acceptA2AInvite).
 *
 * Uses the real DB (via `initializeDb()`) and the test preload which sets
 * `VELLUM_WORKSPACE_DIR` to a per-file temp directory. Global `fetch` is
 * mocked to simulate the outbound call to the sender's gateway.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../../config/loader.js";
import {
  getAssistantContactMetadata,
  getContact,
  searchContacts,
} from "../../../contacts/contact-store.js";
import { getSqlite } from "../../../memory/db-connection.js";
import { initializeDb } from "../../../memory/db-init.js";
import { acceptA2AInvite, createA2AInvite } from "../config-a2a.js";

initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetTables(): void {
  const sqlite = getSqlite();
  sqlite.run("DELETE FROM assistant_ingress_invites");
  sqlite.run("DELETE FROM assistant_contact_metadata");
  sqlite.run("DELETE FROM contact_channels");
  sqlite.run("DELETE FROM contacts");
}

function setConfig(opts: {
  a2aEnabled?: boolean;
  publicBaseUrl?: string;
  ingressEnabled?: boolean;
  assistantName?: string;
}): void {
  const raw = loadRawConfig();
  if (opts.a2aEnabled !== undefined) {
    setNestedValue(raw, "a2a.enabled", opts.a2aEnabled);
  }
  if (opts.publicBaseUrl !== undefined) {
    setNestedValue(raw, "ingress.publicBaseUrl", opts.publicBaseUrl);
  }
  if (opts.ingressEnabled !== undefined) {
    setNestedValue(raw, "ingress.enabled", opts.ingressEnabled);
  }
  saveRawConfig(raw);
  invalidateConfigCache();
}

const SENDER_GATEWAY_URL = "https://sender.example.com";
const SENDER_ASSISTANT_ID = "sender-assistant-abc";
const RECEIVER_GATEWAY_URL = "https://receiver.example.com";

interface MockFetchOptions {
  status?: number;
  body?: Record<string, unknown>;
  networkError?: string;
}

function mockFetchOnce(opts: MockFetchOptions): void {
  const originalFetch = globalThis.fetch;
  const mockFn = mock(
    async (_input: RequestInfo | URL, _init?: RequestInit) => {
      // Restore after first call
      globalThis.fetch = originalFetch;

      if (opts.networkError) {
        throw new Error(opts.networkError);
      }
      return new Response(JSON.stringify(opts.body ?? {}), {
        status: opts.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  globalThis.fetch = mockFn as unknown as typeof fetch;
}

/** Track the outbound fetch call and return a mock response. */
function mockFetchCapture(opts: MockFetchOptions): {
  getCall: () => { url: string; body: Record<string, unknown> } | null;
} {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; body: Record<string, unknown> } | null = null;
  const mockFn = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    globalThis.fetch = originalFetch;
    captured = {
      url: String(input),
      body: JSON.parse((init?.body as string) ?? "{}") as Record<
        string,
        unknown
      >,
    };
    if (opts.networkError) {
      throw new Error(opts.networkError);
    }
    return new Response(JSON.stringify(opts.body ?? {}), {
      status: opts.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = mockFn as unknown as typeof fetch;
  return { getCall: () => captured };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("acceptA2AInvite", () => {
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
    resetTables();
    setConfig({
      a2aEnabled: true,
      publicBaseUrl: RECEIVER_GATEWAY_URL,
      ingressEnabled: true,
    });
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  // ── Happy path ──────────────────────────────────────────────────────

  test("happy path: creates local contact from sender identity", async () => {
    // Create an invite on the sender side so we have a valid token
    const created = createA2AInvite({});
    expect(created.success).toBe(true);

    mockFetchOnce({
      body: {
        success: true,
        sender: {
          assistantId: SENDER_ASSISTANT_ID,
          displayName: "Sender Bot",
          gatewayUrl: SENDER_GATEWAY_URL,
        },
      },
    });

    const result = await acceptA2AInvite({
      senderGatewayUrl: SENDER_GATEWAY_URL,
      senderAssistantId: SENDER_ASSISTANT_ID,
      token: "any-token",
    });

    expect(result.success).toBe(true);
    expect(result.contactId).toBeDefined();
    expect(result.alreadyConnected).toBeFalsy();

    // Verify the contact was created with correct identity
    const contact = getContact(result.contactId!);
    expect(contact).not.toBeNull();
    expect(contact!.channels).toHaveLength(1);
    expect(contact!.channels[0]!.type).toBe("a2a");
    expect(contact!.channels[0]!.status).toBe("active");

    // Verify assistant metadata
    const metadata = getAssistantContactMetadata(result.contactId!);
    expect(metadata).not.toBeNull();
    expect(metadata!.metadata).toEqual({
      assistantId: SENDER_ASSISTANT_ID,
      gatewayUrl: SENDER_GATEWAY_URL,
    });
  });

  test("uses invite-link values for sender identity, not daemon response", async () => {
    const maliciousGateway = "https://evil.example.com";
    const maliciousId = "evil-assistant";

    mockFetchOnce({
      body: {
        success: true,
        sender: {
          // Sender daemon tries to misrepresent identity
          assistantId: maliciousId,
          displayName: "Legit Bot",
          gatewayUrl: maliciousGateway,
        },
      },
    });

    const result = await acceptA2AInvite({
      senderGatewayUrl: SENDER_GATEWAY_URL,
      senderAssistantId: SENDER_ASSISTANT_ID,
      token: "any-token",
    });

    expect(result.success).toBe(true);

    // Verify contact uses invite-link values, NOT the daemon response
    const metadata = getAssistantContactMetadata(result.contactId!);
    expect(metadata!.metadata).toEqual({
      assistantId: SENDER_ASSISTANT_ID,
      gatewayUrl: SENDER_GATEWAY_URL,
    });
  });

  test("uses sender displayName from complete response", async () => {
    mockFetchOnce({
      body: {
        success: true,
        sender: {
          assistantId: SENDER_ASSISTANT_ID,
          displayName: "My Cool Bot",
          gatewayUrl: SENDER_GATEWAY_URL,
        },
      },
    });

    const result = await acceptA2AInvite({
      senderGatewayUrl: SENDER_GATEWAY_URL,
      senderAssistantId: SENDER_ASSISTANT_ID,
      token: "any-token",
    });

    expect(result.success).toBe(true);
    const contact = getContact(result.contactId!);
    expect(contact!.displayName).toBe("My Cool Bot");
  });

  test("falls back to senderAssistantId when displayName is missing", async () => {
    mockFetchOnce({
      body: {
        success: true,
        sender: {
          assistantId: SENDER_ASSISTANT_ID,
          // No displayName
          gatewayUrl: SENDER_GATEWAY_URL,
        },
      },
    });

    const result = await acceptA2AInvite({
      senderGatewayUrl: SENDER_GATEWAY_URL,
      senderAssistantId: SENDER_ASSISTANT_ID,
      token: "any-token",
    });

    expect(result.success).toBe(true);
    const contact = getContact(result.contactId!);
    expect(contact!.displayName).toBe(SENDER_ASSISTANT_ID);
  });

  test("sends correct request to sender's invite/complete endpoint", async () => {
    const capture = mockFetchCapture({
      body: {
        success: true,
        sender: {
          assistantId: SENDER_ASSISTANT_ID,
          displayName: "Sender Bot",
          gatewayUrl: SENDER_GATEWAY_URL,
        },
      },
    });

    await acceptA2AInvite({
      senderGatewayUrl: SENDER_GATEWAY_URL,
      senderAssistantId: SENDER_ASSISTANT_ID,
      token: "test-token-123",
    });

    const call = capture.getCall();
    expect(call).not.toBeNull();
    expect(call!.url).toBe(
      `${SENDER_GATEWAY_URL}/v1/integrations/a2a/invite/complete`,
    );
    expect(call!.body).toEqual({
      token: "test-token-123",
      senderAssistantId: SENDER_ASSISTANT_ID,
      acceptor: {
        assistantId: RECEIVER_GATEWAY_URL,
        displayName: "Vellum Assistant",
        gatewayUrl: RECEIVER_GATEWAY_URL,
      },
    });
  });

  test("strips trailing slashes from senderGatewayUrl", async () => {
    const capture = mockFetchCapture({
      body: {
        success: true,
        sender: {
          assistantId: SENDER_ASSISTANT_ID,
          displayName: "Bot",
          gatewayUrl: SENDER_GATEWAY_URL,
        },
      },
    });

    await acceptA2AInvite({
      senderGatewayUrl: `${SENDER_GATEWAY_URL}///`,
      senderAssistantId: SENDER_ASSISTANT_ID,
      token: "test-token",
    });

    const call = capture.getCall();
    expect(call!.url).toBe(
      `${SENDER_GATEWAY_URL}/v1/integrations/a2a/invite/complete`,
    );
  });

  // ── Already connected ───────────────────────────────────────────────

  test("returns alreadyConnected when sender is already a contact", async () => {
    // First accept
    mockFetchOnce({
      body: {
        success: true,
        sender: {
          assistantId: SENDER_ASSISTANT_ID,
          displayName: "Sender Bot",
          gatewayUrl: SENDER_GATEWAY_URL,
        },
      },
    });
    const first = await acceptA2AInvite({
      senderGatewayUrl: SENDER_GATEWAY_URL,
      senderAssistantId: SENDER_ASSISTANT_ID,
      token: "token-1",
    });
    expect(first.success).toBe(true);

    // Second accept with same sender
    mockFetchOnce({
      body: {
        success: true,
        sender: {
          assistantId: SENDER_ASSISTANT_ID,
          displayName: "Sender Bot",
          gatewayUrl: SENDER_GATEWAY_URL,
        },
      },
    });
    const second = await acceptA2AInvite({
      senderGatewayUrl: SENDER_GATEWAY_URL,
      senderAssistantId: SENDER_ASSISTANT_ID,
      token: "token-2",
    });
    expect(second.success).toBe(true);
    expect(second.alreadyConnected).toBe(true);
  });

  // ── Sender unreachable ──────────────────────────────────────────────

  test("returns sender_unreachable when fetch throws", async () => {
    mockFetchOnce({ networkError: "Connection refused" });

    const result = await acceptA2AInvite({
      senderGatewayUrl: SENDER_GATEWAY_URL,
      senderAssistantId: SENDER_ASSISTANT_ID,
      token: "any-token",
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("sender_unreachable");
    expect(result.error).toContain("Connection refused");
  });

  // ── Sender returns error ────────────────────────────────────────────

  test("returns complete_failed when sender reports failure", async () => {
    mockFetchOnce({
      status: 400,
      body: {
        success: false,
        error: "not_found",
        errorCode: "not_found",
      },
    });

    const result = await acceptA2AInvite({
      senderGatewayUrl: SENDER_GATEWAY_URL,
      senderAssistantId: SENDER_ASSISTANT_ID,
      token: "expired-token",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("not_found");
    expect(result.errorCode).toBe("not_found");
  });

  test("returns complete_failed when sender returns success:false with 200", async () => {
    mockFetchOnce({
      status: 200,
      body: {
        success: false,
        error: "expired",
      },
    });

    const result = await acceptA2AInvite({
      senderGatewayUrl: SENDER_GATEWAY_URL,
      senderAssistantId: SENDER_ASSISTANT_ID,
      token: "any-token",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("expired");
    expect(result.errorCode).toBe("complete_failed");
  });

  // ── No public base URL ──────────────────────────────────────────────

  test("returns no_public_url when publicBaseUrl is not configured", async () => {
    setConfig({ publicBaseUrl: "", ingressEnabled: true });

    const result = await acceptA2AInvite({
      senderGatewayUrl: SENDER_GATEWAY_URL,
      senderAssistantId: SENDER_ASSISTANT_ID,
      token: "any-token",
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("no_public_url");
    expect(result.error).toContain("public base URL");
  });

  test("returns no_public_url when ingress is disabled", async () => {
    setConfig({ ingressEnabled: false });

    const result = await acceptA2AInvite({
      senderGatewayUrl: SENDER_GATEWAY_URL,
      senderAssistantId: SENDER_ASSISTANT_ID,
      token: "any-token",
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("no_public_url");
  });

  // ── No existing contacts leaked ─────────────────────────────────────

  test("does not create a contact when sender returns failure", async () => {
    mockFetchOnce({
      status: 400,
      body: { success: false, error: "invalid" },
    });

    await acceptA2AInvite({
      senderGatewayUrl: SENDER_GATEWAY_URL,
      senderAssistantId: SENDER_ASSISTANT_ID,
      token: "bad-token",
    });

    const contacts = searchContacts({ channelType: "a2a" });
    expect(contacts).toHaveLength(0);
  });
});
