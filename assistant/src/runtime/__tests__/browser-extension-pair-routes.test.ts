/**
 * Tests for the /v1/browser-extension-pair capability-token pair endpoint.
 *
 * Covers:
 *   - Method/host/origin enforcement (405, 403, 400, 401)
 *   - Successful mint on allowed origin (200)
 *   - Issued token round-trips through verifyHostBrowserCapability
 *   - Tampered tokens fail verification
 */

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  resetCapabilityTokenSecretForTests,
  setCapabilityTokenSecretForTests,
  verifyHostBrowserCapability,
} from "../capability-tokens.js";
import { handleBrowserExtensionPair } from "../routes/browser-extension-pair-routes.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type ServerWithRequestIP = {
  requestIP(
    req: Request,
  ): { address: string; family: string; port: number } | null;
};

function mockServer(address: string): ServerWithRequestIP {
  return {
    requestIP: () => ({ address, family: "IPv4", port: 0 }),
  };
}

const loopbackServer = mockServer("127.0.0.1");
const lanPeerServer = mockServer("192.168.1.10");
const publicPeerServer = mockServer("203.0.113.50");

function buildRequest(
  options: {
    method?: string;
    body?: unknown;
    host?: string | null;
    origin?: string;
    forwardedFor?: string;
    rawBody?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (options.host !== null) {
    headers.set("host", options.host ?? "127.0.0.1:8765");
  }
  if (options.forwardedFor) {
    headers.set("x-forwarded-for", options.forwardedFor);
  }
  let bodyStr: string | undefined;
  if (options.rawBody !== undefined) {
    bodyStr = options.rawBody;
    headers.set("content-type", "application/json");
  } else if (options.body !== undefined) {
    bodyStr = JSON.stringify(options.body);
    headers.set("content-type", "application/json");
  }
  return new Request("http://127.0.0.1:8765/v1/browser-extension-pair", {
    method: options.method ?? "POST",
    headers,
    body: bodyStr,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleBrowserExtensionPair", () => {
  beforeEach(() => {
    resetCapabilityTokenSecretForTests();
    setCapabilityTokenSecretForTests(randomBytes(32));
  });

  test("rejects non-POST methods with 405", async () => {
    const req = buildRequest({
      method: "GET",
      body: { origin: "chrome-extension://fakedevid/" },
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(405);
  });

  test("rejects non-loopback peer with 403", async () => {
    const req = buildRequest({
      body: { origin: "chrome-extension://fakedevid/" },
    });
    const res = await handleBrowserExtensionPair(req, publicPeerServer);
    expect(res.status).toBe(403);
  });

  test("rejects LAN peer (not loopback) with 403", async () => {
    const req = buildRequest({
      body: { origin: "chrome-extension://fakedevid/" },
    });
    const res = await handleBrowserExtensionPair(req, lanPeerServer);
    expect(res.status).toBe(403);
  });

  test("rejects request with non-loopback Host header", async () => {
    const req = buildRequest({
      body: { origin: "chrome-extension://fakedevid/" },
      host: "vellum.example.com",
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(403);
  });

  test("rejects request with x-forwarded-for header", async () => {
    const req = buildRequest({
      body: { origin: "chrome-extension://fakedevid/" },
      forwardedFor: "1.2.3.4",
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(403);
  });

  test("returns 400 when body is missing", async () => {
    const req = buildRequest({});
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(400);
  });

  test("returns 400 when body is malformed JSON", async () => {
    const req = buildRequest({ rawBody: "{not json" });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(400);
  });

  test("returns 400 when origin is missing", async () => {
    const req = buildRequest({ body: {} });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(400);
  });

  test("returns 400 when origin is not a string", async () => {
    const req = buildRequest({ body: { origin: 42 } });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(400);
  });

  test("returns 401 when origin is not on the allowlist", async () => {
    const req = buildRequest({
      body: { origin: "chrome-extension://not-allowed/" },
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(401);
  });

  test("returns 200 with a valid token for an allowed origin", async () => {
    const req = buildRequest({
      body: { origin: "chrome-extension://fakedevid/" },
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(200);

    const payload = (await res.json()) as {
      token: string;
      expiresAt: number;
      guardianId: string;
    };

    expect(typeof payload.token).toBe("string");
    expect(payload.token.length).toBeGreaterThan(0);
    expect(typeof payload.expiresAt).toBe("number");
    expect(payload.expiresAt).toBeGreaterThan(Date.now());
    expect(typeof payload.guardianId).toBe("string");
    expect(payload.guardianId.length).toBeGreaterThan(0);

    // Token should round-trip through verifyHostBrowserCapability.
    const claims = verifyHostBrowserCapability(payload.token);
    expect(claims).not.toBeNull();
    expect(claims?.capability).toBe("host_browser_command");
    expect(claims?.guardianId).toBe(payload.guardianId);
    expect(claims?.expiresAt).toBe(payload.expiresAt);
  });

  test("accepts loopback Host header variants", async () => {
    const variants = [
      "localhost:8765",
      "127.0.0.1:8765",
      "127.0.0.1",
      "localhost",
    ];
    for (const host of variants) {
      const req = buildRequest({
        body: { origin: "chrome-extension://fakedevid/" },
        host,
      });
      const res = await handleBrowserExtensionPair(req, loopbackServer);
      expect(res.status).toBe(200);
    }
  });

  test("tampered tokens fail verification", async () => {
    const req = buildRequest({
      body: { origin: "chrome-extension://fakedevid/" },
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(200);

    const payload = (await res.json()) as { token: string };
    const originalToken = payload.token;

    // Modify the signature: flip the last character.
    const [head, sig] = originalToken.split(".");
    const lastChar = sig.slice(-1);
    const replacement = lastChar === "A" ? "B" : "A";
    const tamperedToken = `${head}.${sig.slice(0, -1)}${replacement}`;

    expect(verifyHostBrowserCapability(tamperedToken)).toBeNull();
    // The original token should still verify.
    expect(verifyHostBrowserCapability(originalToken)).not.toBeNull();
  });

  test("tokens minted with a different secret fail verification", async () => {
    // Mint a token, then swap the secret — verification should fail.
    const req = buildRequest({
      body: { origin: "chrome-extension://fakedevid/" },
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { token: string };

    // Swap secret and re-verify.
    setCapabilityTokenSecretForTests(randomBytes(32));
    expect(verifyHostBrowserCapability(payload.token)).toBeNull();
  });

  test("rejects tampered payload even with matching signature length", async () => {
    const req = buildRequest({
      body: { origin: "chrome-extension://fakedevid/" },
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { token: string };
    const [head, sig] = payload.token.split(".");

    // Swap the payload for a different base64url value of equivalent shape.
    const bogusPayload = Buffer.from(
      JSON.stringify({
        capability: "host_browser_command",
        guardianId: "attacker",
        nonce: "00".repeat(16),
        expiresAt: Date.now() + 60_000,
      }),
      "utf8",
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const tampered = `${bogusPayload}.${sig}`;
    // Keep `head` referenced so the test reads naturally even though we
    // do not use it after tampering.
    expect(head).toBeTruthy();
    expect(verifyHostBrowserCapability(tampered)).toBeNull();
  });
});
