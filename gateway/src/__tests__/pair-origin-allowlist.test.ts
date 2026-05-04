/**
 * Tests for ATL-433: /v1/pair validates Origin against KNOWN_EXTENSION_ORIGINS,
 * and resolveExtensionOrigin uses the same allowlist.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

import { initSigningKey } from "../auth/token-service.js";

// Must init signing key before any module that mints tokens is imported.
initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long-xx"));

// Mock DB — pair.ts calls resolveLocalGuardianPrincipalId() which queries the DB.
const mockQuery = mock();
mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mockQuery,
  assistantDbRun: mock(),
  assistantDbExec: mock(),
}));

const { handlePair, resetPairRateLimiterForTests } = await import(
  "../http/routes/pair.js"
);
const { resolveExtensionOrigin } = await import(
  "../http/middleware/cors.js"
);
const { KNOWN_EXTENSION_ORIGINS } = await import(
  "../chrome-extension-origins.js"
);

// Simulate a loopback peer IP as supplied by the gateway server to the handler.
const LOOPBACK_IP = "127.0.0.1";

// A valid Vellum extension origin (production).
const PROD_ORIGIN = "chrome-extension://hphbdmpffeigpcdjkckleobjmhhokpne";
// A non-Vellum extension origin.
const MALICIOUS_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function makePairRequest(overrides: {
  method?: string;
  origin?: string | null;
  interfaceId?: string | null;
  xForwardedFor?: string;
} = {}): Request {
  const { method = "POST", origin, interfaceId = "chrome-extension", xForwardedFor } = overrides;
  const headers: Record<string, string> = {
    "host": "localhost:7830",
    "content-type": "application/json",
  };
  if (origin !== null) {
    headers["origin"] = origin ?? PROD_ORIGIN;
  }
  if (interfaceId !== null) {
    headers["x-vellum-interface-id"] = interfaceId;
  }
  if (xForwardedFor) {
    headers["x-forwarded-for"] = xForwardedFor;
  }
  return new Request("http://localhost:7830/v1/pair", { method, headers });
}

beforeEach(() => {
  resetPairRateLimiterForTests();
  mockQuery.mockResolvedValue([{ principalId: "guardian-001" }]);
});

// ---------------------------------------------------------------------------
// resolveExtensionOrigin — allowlist behaviour
// ---------------------------------------------------------------------------

describe("resolveExtensionOrigin", () => {
  test("returns origin for every known Vellum extension ID", () => {
    for (const origin of KNOWN_EXTENSION_ORIGINS) {
      const req = new Request("http://localhost:7830/v1/events", {
        headers: { origin },
      });
      expect(resolveExtensionOrigin(req)).toBe(origin);
    }
  });

  test("returns null for an unknown chrome-extension:// origin", () => {
    const req = new Request("http://localhost:7830/v1/events", {
      headers: { origin: MALICIOUS_ORIGIN },
    });
    expect(resolveExtensionOrigin(req)).toBeNull();
  });

  test("returns null when Origin header is absent", () => {
    const req = new Request("http://localhost:7830/v1/events");
    expect(resolveExtensionOrigin(req)).toBeNull();
  });

  test("returns null for a non-extension origin (web page)", () => {
    const req = new Request("http://localhost:7830/v1/events", {
      headers: { origin: "https://evil.example.com" },
    });
    expect(resolveExtensionOrigin(req)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /v1/pair — Origin check for chrome-extension interface
// ---------------------------------------------------------------------------

describe("handlePair — Origin allowlist", () => {
  test("pairs successfully with a known prod extension origin", async () => {
    const req = makePairRequest({ origin: PROD_ORIGIN });
    const res = await handlePair(req, LOOPBACK_IP);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.token).toBe("string");
  });

  test("pairs successfully with each known extension origin", async () => {
    for (const origin of KNOWN_EXTENSION_ORIGINS) {
      resetPairRateLimiterForTests();
      const req = makePairRequest({ origin });
      const res = await handlePair(req, LOOPBACK_IP);
      expect(res.status).toBe(200);
    }
  });

  test("rejects a request from an unknown extension origin with 403", async () => {
    const req = makePairRequest({ origin: MALICIOUS_ORIGIN });
    const res = await handlePair(req, LOOPBACK_IP);
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, unknown>;
    expect((body.error as Record<string, unknown>).code).toBe("FORBIDDEN");
  });

  test("rejects a request with no Origin header with 403", async () => {
    const req = makePairRequest({ origin: null });
    const res = await handlePair(req, LOOPBACK_IP);
    expect(res.status).toBe(403);
  });

  test("still rejects non-loopback callers regardless of origin", async () => {
    const req = makePairRequest({ origin: PROD_ORIGIN });
    const res = await handlePair(req, "8.8.8.8");
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, unknown>;
    expect((body.error as Record<string, unknown>).code).toBe("FORBIDDEN");
  });

  test("still rejects requests with X-Forwarded-For regardless of origin", async () => {
    const req = makePairRequest({ origin: PROD_ORIGIN, xForwardedFor: "1.2.3.4" });
    const res = await handlePair(req, LOOPBACK_IP);
    expect(res.status).toBe(403);
  });

  test("still rejects unknown interface IDs (unrelated to origin check)", async () => {
    const req = makePairRequest({ origin: PROD_ORIGIN, interfaceId: "unknown-client" });
    const res = await handlePair(req, LOOPBACK_IP);
    expect(res.status).toBe(400);
  });
});
