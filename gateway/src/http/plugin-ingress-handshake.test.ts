/**
 * Tests for the signed-query plugin ingress handshake.
 *
 * The scheme exists so a caller that can only be handed a URL can still
 * authenticate, which means the URL is a bearer credential. These tests are
 * mostly about the ways that could go wrong: outliving its expiry, being
 * replayed against another route, or being minted to never expire at all.
 */

import { describe, expect, test } from "bun:test";

import {
  HANDSHAKE_EXPIRY_PARAM,
  HANDSHAKE_SIGNATURE_PARAM,
  MAX_HANDSHAKE_TTL_SECONDS,
  signHandshakeUrl,
  verifySignedQueryHandshake,
} from "./plugin-ingress-handshake.js";

const SECRET = "s3cret-webhook-key";
const NOW_MS = 1_760_000_000_000;
const PATH = "/webhooks/plugins/meeting-bot/realtime";

function mint(
  opts: { ttlSeconds?: number; nowMs?: number; pathname?: string } = {},
): URL {
  return signHandshakeUrl({
    url: new URL(`wss://assistant.example${opts.pathname ?? PATH}`),
    secret: SECRET,
    ttlSeconds: opts.ttlSeconds ?? 3600,
    nowMs: opts.nowMs ?? NOW_MS,
  });
}

describe("signHandshakeUrl", () => {
  test("adds both parameters and leaves the path alone", () => {
    const url = mint();
    expect(url.pathname).toBe(PATH);
    expect(url.searchParams.get(HANDSHAKE_EXPIRY_PARAM)).toBe(
      String(Math.floor(NOW_MS / 1000) + 3600),
    );
    expect(url.searchParams.get(HANDSHAKE_SIGNATURE_PARAM)).toMatch(
      /^sha256=[0-9a-f]{64}$/,
    );
  });

  test("refuses a TTL past the scheme's maximum", () => {
    // A minter that could pick any expiry could mint a URL that never
    // meaningfully expires, which is the one thing the bound exists to stop.
    expect(() =>
      signHandshakeUrl({
        url: new URL(`wss://assistant.example${PATH}`),
        secret: SECRET,
        ttlSeconds: MAX_HANDSHAKE_TTL_SECONDS + 1,
      }),
    ).toThrow(/maximum/);
  });

  test("refuses a non-positive or fractional TTL", () => {
    for (const ttlSeconds of [0, -1, 1.5]) {
      expect(() =>
        signHandshakeUrl({
          url: new URL(`wss://assistant.example${PATH}`),
          secret: SECRET,
          ttlSeconds,
        }),
      ).toThrow(/positive integer/);
    }
  });
});

describe("verifySignedQueryHandshake", () => {
  test("accepts a URL it just minted", () => {
    const url = mint();
    const result = verifySignedQueryHandshake({
      url,
      pathname: PATH,
      secret: SECRET,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({
      ok: true,
      expirySeconds: Math.floor(NOW_MS / 1000) + 3600,
    });
  });

  test("accepts right up to the expiry and refuses at it", () => {
    const url = mint({ ttlSeconds: 60 });
    const expiryMs = NOW_MS + 60_000;
    expect(
      verifySignedQueryHandshake({
        url,
        pathname: PATH,
        secret: SECRET,
        nowMs: expiryMs - 1000,
      }).ok,
    ).toBe(true);
    expect(
      verifySignedQueryHandshake({
        url,
        pathname: PATH,
        secret: SECRET,
        nowMs: expiryMs,
      }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  test("refuses a URL minted for a different route", () => {
    // The whole point of binding the pathname: a plugin's realtime URL must
    // not open any other declared route, its own or another plugin's.
    const url = mint({ pathname: "/webhooks/plugins/meeting-bot/realtime" });
    const replayed = new URL(url.toString());
    replayed.pathname = "/webhooks/plugins/other-plugin/realtime";
    expect(
      verifySignedQueryHandshake({
        url: replayed,
        pathname: replayed.pathname,
        secret: SECRET,
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("refuses a signature made with a different secret", () => {
    const url = mint();
    expect(
      verifySignedQueryHandshake({
        url,
        pathname: PATH,
        secret: "rotated-to-something-else",
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("refuses an expiry stretched past the maximum after minting", () => {
    // Rewriting the expiry invalidates the signature, but the TTL bound is
    // checked first so the refusal names the real problem.
    const url = mint();
    url.searchParams.set(
      HANDSHAKE_EXPIRY_PARAM,
      String(Math.floor(NOW_MS / 1000) + MAX_HANDSHAKE_TTL_SECONDS + 60),
    );
    expect(
      verifySignedQueryHandshake({
        url,
        pathname: PATH,
        secret: SECRET,
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: false, reason: "ttl_too_long" });
  });

  test("refuses a non-canonical expiry rather than parsing it", () => {
    // "0123" and "1.76e12" parse to numbers the minter never signed; accepting
    // them would mean verifying against a payload built from a different
    // string than the one on the wire.
    for (const raw of ["0123", "1.76e12", " 1760003600", "1760003600.0"]) {
      const url = mint();
      url.searchParams.set(HANDSHAKE_EXPIRY_PARAM, raw);
      expect(
        verifySignedQueryHandshake({
          url,
          pathname: PATH,
          secret: SECRET,
          nowMs: NOW_MS,
        }),
      ).toEqual({ ok: false, reason: "malformed_expiry" });
    }
  });

  test("refuses when either parameter is absent", () => {
    for (const drop of [HANDSHAKE_EXPIRY_PARAM, HANDSHAKE_SIGNATURE_PARAM]) {
      const url = mint();
      url.searchParams.delete(drop);
      expect(
        verifySignedQueryHandshake({
          url,
          pathname: PATH,
          secret: SECRET,
          nowMs: NOW_MS,
        }),
      ).toEqual({ ok: false, reason: "missing" });
    }
  });

  test("refuses an empty secret rather than treating it as a valid key", () => {
    const url = mint();
    expect(
      verifySignedQueryHandshake({
        url,
        pathname: PATH,
        secret: "",
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("ignores unrelated query parameters the caller appended", () => {
    // Recall appends nothing today, but a caller adding its own parameters
    // must not invalidate a URL: only the two named ones are signed.
    const url = mint();
    url.searchParams.set("bot_id", "abc123");
    expect(
      verifySignedQueryHandshake({
        url,
        pathname: PATH,
        secret: SECRET,
        nowMs: NOW_MS,
      }).ok,
    ).toBe(true);
  });
});
