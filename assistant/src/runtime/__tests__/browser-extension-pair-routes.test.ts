/**
 * Tests for the /v1/browser-extension-pair capability-token pair endpoint.
 *
 * Covers:
 *   - Method/host/origin enforcement (405, 403, 400, 401)
 *   - Successful mint on allowed origin (200) for both the preferred
 *     `extensionOrigin` body field and the legacy `origin` alias
 *   - `expiresAt` response field is an ISO 8601 string matching what the
 *     native messaging helper validates
 *   - IPv6 loopback `Host` header variants (bracketed and bare) are
 *     accepted
 *   - Issued token round-trips through `verifyHostBrowserCapability`
 *   - Tampered tokens fail verification
 */

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  resetCapabilityTokenSecretForTests,
  setCapabilityTokenSecretForTests,
  verifyHostBrowserCapability,
} from "../capability-tokens.js";
import {
  handleBrowserExtensionPair,
  parseHostHeader,
} from "../routes/browser-extension-pair-routes.js";

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
      body: {
        extensionOrigin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
      },
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(405);
  });

  test("rejects non-loopback peer with 403", async () => {
    const req = buildRequest({
      body: {
        extensionOrigin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
      },
    });
    const res = await handleBrowserExtensionPair(req, publicPeerServer);
    expect(res.status).toBe(403);
  });

  test("rejects LAN peer (not loopback) with 403", async () => {
    const req = buildRequest({
      body: {
        extensionOrigin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
      },
    });
    const res = await handleBrowserExtensionPair(req, lanPeerServer);
    expect(res.status).toBe(403);
  });

  test("rejects request with non-loopback Host header", async () => {
    const req = buildRequest({
      body: {
        extensionOrigin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
      },
      host: "vellum.example.com",
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(403);
  });

  test("rejects request with x-forwarded-for header", async () => {
    const req = buildRequest({
      body: {
        extensionOrigin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
      },
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

  test("returns 400 when extensionOrigin is missing", async () => {
    const req = buildRequest({ body: {} });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(400);
  });

  test("returns 400 when extensionOrigin is not a string", async () => {
    const req = buildRequest({ body: { extensionOrigin: 42 } });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(400);
  });

  test("returns 400 when legacy origin field is not a string", async () => {
    const req = buildRequest({ body: { origin: 42 } });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(400);
  });

  test("returns 401 when extensionOrigin is not on the allowlist", async () => {
    const req = buildRequest({
      body: { extensionOrigin: "chrome-extension://not-allowed/" },
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(401);
  });

  test("returns 200 with a valid token for the preferred extensionOrigin field", async () => {
    const req = buildRequest({
      body: {
        extensionOrigin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
      },
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(200);

    const payload = (await res.json()) as {
      token: string;
      expiresAt: string;
      guardianId: string;
    };

    expect(typeof payload.token).toBe("string");
    expect(payload.token.length).toBeGreaterThan(0);

    // expiresAt must be an ISO 8601 string (matching what the
    // chrome-extension-native-host helper validates) and must be in
    // the future.
    expect(typeof payload.expiresAt).toBe("string");
    expect(payload.expiresAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    const expiresAtMs = Date.parse(payload.expiresAt);
    expect(Number.isNaN(expiresAtMs)).toBe(false);
    expect(expiresAtMs).toBeGreaterThan(Date.now());

    expect(typeof payload.guardianId).toBe("string");
    expect(payload.guardianId.length).toBeGreaterThan(0);

    // Token should round-trip through verifyHostBrowserCapability.
    const claims = verifyHostBrowserCapability(payload.token);
    expect(claims).not.toBeNull();
    expect(claims?.capability).toBe("host_browser_command");
    expect(claims?.guardianId).toBe(payload.guardianId);
    // The numeric claim expiry should match the ISO response field.
    expect(claims?.expiresAt).toBe(expiresAtMs);
  });

  test("returns 200 using the legacy `origin` field for backwards compat", async () => {
    const req = buildRequest({
      body: { origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/" },
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      token: string;
      expiresAt: string;
    };
    expect(typeof payload.token).toBe("string");
    expect(typeof payload.expiresAt).toBe("string");
  });

  test("prefers extensionOrigin over legacy origin when both are provided", async () => {
    // extensionOrigin is on the allowlist, `origin` is not — so the
    // request must succeed because we honor `extensionOrigin` first.
    const req = buildRequest({
      body: {
        extensionOrigin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
        origin: "chrome-extension://not-allowed/",
      },
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(200);
  });

  test("accepts loopback Host header variants", async () => {
    const variants = [
      "localhost:8765",
      "127.0.0.1:8765",
      "127.0.0.1",
      "localhost",
      "127.1.2.3:8765",
      "[::1]:8765",
      "[::1]",
      "::1",
    ];
    for (const host of variants) {
      const req = buildRequest({
        body: {
          extensionOrigin:
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
        },
        host,
      });
      const res = await handleBrowserExtensionPair(req, loopbackServer);
      expect(res.status).toBe(200);
    }
  });

  test("rejects malformed bracketed Host header", async () => {
    const req = buildRequest({
      body: {
        extensionOrigin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
      },
      host: "[::1", // missing closing bracket
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(403);
  });

  test("rejects bracketed Host header with junk after closing bracket", async () => {
    // Defensive against `[::1]attacker.com`-style injection: the parser
    // used to silently truncate at the first `]` and treat the rest as
    // the hostname, which would let an attacker spoof a non-loopback
    // host while still passing the loopback Host header check.
    const req = buildRequest({
      body: {
        extensionOrigin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
      },
      host: "[::1]attacker.com",
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(403);
  });

  test("rejects non-loopback IPv6 Host header", async () => {
    const req = buildRequest({
      body: {
        extensionOrigin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
      },
      host: "[2001:db8::1]:8765",
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(403);
  });

  test("parseHostHeader handles IPv4, IPv6, and bracketed forms", () => {
    expect(parseHostHeader("localhost:8765")).toBe("localhost");
    expect(parseHostHeader("127.0.0.1:8765")).toBe("127.0.0.1");
    expect(parseHostHeader("127.0.0.1")).toBe("127.0.0.1");
    expect(parseHostHeader("[::1]:8765")).toBe("::1");
    expect(parseHostHeader("[::1]")).toBe("::1");
    expect(parseHostHeader("::1")).toBe("::1");
    expect(parseHostHeader("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(parseHostHeader("[::1")).toBeNull();
    expect(parseHostHeader("")).toBeNull();
    // Anything after the closing bracket that isn't an optional ":port"
    // must be rejected — otherwise `[::1]attacker.com` would slip past
    // the loopback check by parsing as `::1`.
    expect(parseHostHeader("[::1]attacker.com")).toBeNull();
    expect(parseHostHeader("[::1]extra")).toBeNull();
  });

  test("tampered tokens fail verification", async () => {
    const req = buildRequest({
      body: {
        extensionOrigin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
      },
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
      body: {
        extensionOrigin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
      },
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
      body: {
        extensionOrigin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
      },
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
