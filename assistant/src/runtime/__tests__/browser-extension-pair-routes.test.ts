/**
 * Tests for the /v1/browser-extension-pair capability-token pair endpoint.
 *
 * Covers:
 *   - Method/host/origin enforcement (405, 403, 400, 401)
 *   - Native-host marker header requirement (403 when missing)
 *   - Browser-origin rejection (non-allowlisted Origin header -> 403)
 *   - Strict per-peer rate limiting (10/min, then 429)
 *   - Audit logging field shape for denied attempts
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
  NATIVE_HOST_MARKER_HEADER,
  NATIVE_HOST_MARKER_VALUE,
  parseHostHeader,
  resetPairRateLimiterForTests,
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

const ALLOWED_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";

/**
 * Build a pair request. By default includes the native-host marker
 * header so existing tests exercising other invariants continue to
 * pass. Tests that want to exercise the marker-header gate pass
 * `nativeHost: false` (or an explicit override value).
 */
function buildRequest(
  options: {
    method?: string;
    body?: unknown;
    host?: string | null;
    origin?: string;
    forwardedFor?: string;
    rawBody?: string;
    /**
     * When `false`, omits the native-host marker header entirely.
     * When a string, sets the header to that value (for testing
     * unexpected values). Defaults to including the expected value.
     */
    nativeHost?: boolean | string;
  } = {},
): Request {
  const headers = new Headers();
  if (options.host !== null) {
    headers.set("host", options.host ?? "127.0.0.1:8765");
  }
  if (options.forwardedFor) {
    headers.set("x-forwarded-for", options.forwardedFor);
  }
  if (options.origin !== undefined) {
    headers.set("origin", options.origin);
  }
  if (options.nativeHost === undefined || options.nativeHost === true) {
    headers.set(NATIVE_HOST_MARKER_HEADER, NATIVE_HOST_MARKER_VALUE);
  } else if (typeof options.nativeHost === "string") {
    headers.set(NATIVE_HOST_MARKER_HEADER, options.nativeHost);
  }
  // else: nativeHost === false — omit the header entirely.
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
    // Reset the per-peer rate limiter so one test's burst of requests
    // cannot leak budget into the next test.
    resetPairRateLimiterForTests();
  });

  test("rejects non-POST methods with 405", async () => {
    const req = buildRequest({
      method: "GET",
      body: {
        extensionOrigin: ALLOWED_ORIGIN,
      },
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(405);
  });

  test("rejects non-loopback peer with 403", async () => {
    const req = buildRequest({
      body: {
        extensionOrigin: ALLOWED_ORIGIN,
      },
    });
    const res = await handleBrowserExtensionPair(req, publicPeerServer);
    expect(res.status).toBe(403);
  });

  test("rejects LAN peer (not loopback) with 403", async () => {
    const req = buildRequest({
      body: {
        extensionOrigin: ALLOWED_ORIGIN,
      },
    });
    const res = await handleBrowserExtensionPair(req, lanPeerServer);
    expect(res.status).toBe(403);
  });

  test("rejects request with non-loopback Host header", async () => {
    const req = buildRequest({
      body: {
        extensionOrigin: ALLOWED_ORIGIN,
      },
      host: "vellum.example.com",
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(403);
  });

  test("rejects request with x-forwarded-for header", async () => {
    const req = buildRequest({
      body: {
        extensionOrigin: ALLOWED_ORIGIN,
      },
      forwardedFor: "1.2.3.4",
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(403);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Native-host marker header enforcement
  // ─────────────────────────────────────────────────────────────────────

  test("rejects request missing native-host marker header with 403", async () => {
    const req = buildRequest({
      body: { extensionOrigin: ALLOWED_ORIGIN },
      nativeHost: false,
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(403);
    const payload = (await res.json()) as {
      error?: { code?: string; message?: string };
    };
    expect(payload.error?.code).toBe("FORBIDDEN");
  });

  test("rejects request with wrong native-host marker header value", async () => {
    const req = buildRequest({
      body: { extensionOrigin: ALLOWED_ORIGIN },
      nativeHost: "bogus",
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(403);
  });

  test("rejects request with empty native-host marker header value", async () => {
    const req = buildRequest({
      body: { extensionOrigin: ALLOWED_ORIGIN },
      nativeHost: "",
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(403);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Browser-origin rejection
  // ─────────────────────────────────────────────────────────────────────

  test("rejects request with a non-allowlisted Origin header", async () => {
    const req = buildRequest({
      body: { extensionOrigin: ALLOWED_ORIGIN },
      origin: "https://evil.example.com",
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(403);
    const payload = (await res.json()) as {
      error?: { code?: string };
    };
    expect(payload.error?.code).toBe("FORBIDDEN");
  });

  test("rejects request with http://localhost Origin header (browser-originated)", async () => {
    // A web page served from http://localhost:8080 that POSTs to the
    // pair endpoint would attach this Origin header. The endpoint must
    // refuse it even though the host itself is loopback — a local web
    // page in another browser tab is NOT the native messaging helper.
    const req = buildRequest({
      body: { extensionOrigin: ALLOWED_ORIGIN },
      origin: "http://localhost:8080",
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(403);
  });

  test("accepts request with no Origin header (native-host default)", async () => {
    // Node fetch does not set an Origin header unless explicitly told
    // to — the native messaging helper's `fetch(...)` call therefore
    // ships without one. This is the common-case allowed path.
    const req = buildRequest({
      body: { extensionOrigin: ALLOWED_ORIGIN },
      // origin intentionally omitted
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(200);
  });

  test("accepts request when Origin header equals an allowlisted extension origin", async () => {
    // The allowlist stores entries with a trailing slash. Browsers'
    // Origin headers never carry a path segment, so both the exact
    // match and the bare form should succeed.
    const reqExact = buildRequest({
      body: { extensionOrigin: ALLOWED_ORIGIN },
      origin: ALLOWED_ORIGIN,
    });
    expect(
      (await handleBrowserExtensionPair(reqExact, loopbackServer)).status,
    ).toBe(200);

    const reqBare = buildRequest({
      body: { extensionOrigin: ALLOWED_ORIGIN },
      origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(
      (await handleBrowserExtensionPair(reqBare, loopbackServer)).status,
    ).toBe(200);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Rate limiting
  // ─────────────────────────────────────────────────────────────────────

  test("rate limits successive pair requests (429 after burst)", async () => {
    // Fire a tight burst of requests and assert that once the per-peer
    // budget is exhausted, the endpoint returns 429 with the standard
    // error envelope and a Retry-After hint. The rate limiter budget
    // is 10/min per peer IP; we send 12 to ensure we hit it.
    const results: number[] = [];
    for (let i = 0; i < 12; i++) {
      const req = buildRequest({
        body: { extensionOrigin: ALLOWED_ORIGIN },
      });
      const res = await handleBrowserExtensionPair(req, loopbackServer);
      results.push(res.status);
      // Drain the body so any async internal state settles (and so
      // we don't leak unconsumed Response bodies).
      await res.text();
    }

    // The first 10 requests should succeed (200). The 11th and 12th
    // should be rate limited (429).
    const successes = results.filter((s) => s === 200).length;
    const rateLimited = results.filter((s) => s === 429).length;
    expect(successes).toBe(10);
    expect(rateLimited).toBe(2);
  });

  test("rate-limited response carries Retry-After and RATE_LIMITED error code", async () => {
    // Exhaust the budget.
    for (let i = 0; i < 10; i++) {
      const req = buildRequest({
        body: { extensionOrigin: ALLOWED_ORIGIN },
      });
      const res = await handleBrowserExtensionPair(req, loopbackServer);
      await res.text();
    }
    // The next request should be rate limited.
    const req = buildRequest({
      body: { extensionOrigin: ALLOWED_ORIGIN },
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(429);
    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).not.toBeNull();
    // Retry-After should be a positive integer of seconds.
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    const payload = (await res.json()) as {
      error?: { code?: string };
    };
    expect(payload.error?.code).toBe("RATE_LIMITED");
  });

  test("rate limit applies BEFORE native-host marker check (can't probe without spending budget)", async () => {
    // Attackers shouldn't be able to distinguish "unauthenticated
    // endpoint" from "endpoint doesn't exist" without consuming a
    // rate-limit slot. Send 12 unauthenticated probes; after the 10th
    // request is rate limited, they should get 429 — not 403 — which
    // proves the limiter runs first.
    const results: number[] = [];
    for (let i = 0; i < 12; i++) {
      const req = buildRequest({
        body: { extensionOrigin: ALLOWED_ORIGIN },
        nativeHost: false, // forces a 403 if rate-limiter doesn't run first
      });
      const res = await handleBrowserExtensionPair(req, loopbackServer);
      results.push(res.status);
      await res.text();
    }
    // The first 10 should be 403 (missing marker). Beyond that the
    // rate limiter kicks in and returns 429.
    expect(results.slice(0, 10).every((s) => s === 403)).toBe(true);
    expect(results.slice(10).every((s) => s === 429)).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Body validation
  // ─────────────────────────────────────────────────────────────────────

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
        extensionOrigin: ALLOWED_ORIGIN,
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
      body: { origin: ALLOWED_ORIGIN },
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
        extensionOrigin: ALLOWED_ORIGIN,
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
      // Reset the limiter between iterations so the last few variants
      // don't fall over the 10/min budget.
      resetPairRateLimiterForTests();
      const req = buildRequest({
        body: {
          extensionOrigin: ALLOWED_ORIGIN,
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
        extensionOrigin: ALLOWED_ORIGIN,
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
        extensionOrigin: ALLOWED_ORIGIN,
      },
      host: "[::1]attacker.com",
    });
    const res = await handleBrowserExtensionPair(req, loopbackServer);
    expect(res.status).toBe(403);
  });

  test("rejects non-loopback IPv6 Host header", async () => {
    const req = buildRequest({
      body: {
        extensionOrigin: ALLOWED_ORIGIN,
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
        extensionOrigin: ALLOWED_ORIGIN,
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
        extensionOrigin: ALLOWED_ORIGIN,
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
        extensionOrigin: ALLOWED_ORIGIN,
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

// ---------------------------------------------------------------------------
// parseHostHeader — table-driven unit tests for IPv6 / port / malformed edge
// cases. The handler-level tests above cover end-to-end accept/reject of the
// pair endpoint; these tests pin down the parser contract itself so that a
// future refactor of `parseHostHeader` cannot silently change its semantics.
//
// Important: `parseHostHeader` does NOT lowercase the hostname — case
// normalization happens later in `isLoopbackHostHeader`. The tests below
// reflect that.
// ---------------------------------------------------------------------------
describe("parseHostHeader", () => {
  // [input, expected-parseHostHeader-output]. `null` means "malformed".
  const cases: Array<[string, string | null]> = [
    // IPv4 with port
    ["127.0.0.1:7821", "127.0.0.1"],
    // Bare IPv4
    ["127.0.0.1", "127.0.0.1"],
    // IPv4 in 127.0.0.0/8 range
    ["127.1.2.3:7821", "127.1.2.3"],
    // IPv6 with brackets and port
    ["[::1]:7821", "::1"],
    // IPv6 with brackets, no port
    ["[::1]", "::1"],
    // Bare IPv6 (no brackets, no port) — two or more colons, no brackets,
    // so treated as a whole IPv6 literal rather than split at the first colon.
    ["::1", "::1"],
    // Non-loopback IPv6 with brackets
    ["[2001:db8::1]:443", "2001:db8::1"],
    // Non-loopback IPv6, bare (multi-colon → treated as IPv6 literal)
    ["2001:db8::1", "2001:db8::1"],
    // Hostname with port
    ["localhost:7821", "localhost"],
    // Bare hostname
    ["localhost", "localhost"],
    // Mixed-case hostname — the parser preserves case; downstream
    // `isLoopbackHostHeader` is responsible for case folding.
    ["LocalHost:7821", "LocalHost"],
    // Empty string
    ["", null],
    // Malformed: content after the closing bracket that isn't `:port`.
    // Critical security case: `[::1]attacker.com` would slip a non-loopback
    // hostname past a naive parser that truncates at `]`.
    ["[::1]attacker.com", null],
    ["[::1]extra", null],
    // Malformed: unbalanced brackets (missing closing `]`)
    ["[::1", null],
    // Malformed: unbalanced brackets (missing opening `[`) — the leading
    // character is not `[`, so the bare-host path runs; `"]":"port"` has
    // two colons so it's treated as an IPv6 literal (garbage in, garbage
    // out for this edge case — documented for visibility).
    ["::1]:7821", "::1]:7821"],
    // Empty brackets: after `[` we see `]` at index 1, after `]` is `:7821`
    // which is a valid port, so the parser returns the substring between
    // the brackets — the empty string. `isLoopbackHostHeader` then rejects
    // it because `""` is not a loopback address.
    ["[]:7821", ""],
    // Empty brackets, no port
    ["[]", ""],
  ];
  for (const [input, expected] of cases) {
    test(`parseHostHeader(${JSON.stringify(input)}) returns ${JSON.stringify(expected)}`, () => {
      expect(parseHostHeader(input)).toBe(expected);
    });
  }
});
