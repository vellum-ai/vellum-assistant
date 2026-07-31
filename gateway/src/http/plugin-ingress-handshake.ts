/**
 * The signed-query handshake for plugin ingress WebSocket routes.
 *
 * ## Why a second handshake scheme
 *
 * The header scheme (`Vellum-Signature` / `Vellum-Timestamp`, see
 * `./vellum-signature.ts`) assumes the caller controls its request headers.
 * Some callers cannot: a third-party service is handed a single URL and dials
 * it, with no place to put a header. Recall.ai's realtime endpoint is the case
 * that forced this. For those routes the whole credential has to live in the
 * URL.
 *
 * ## What it signs, and why not a timestamp
 *
 * `HMAC-SHA256(secret, "<expiry>.<pathname>")`, carried as two query
 * parameters. Binding the pathname keeps a URL minted for one route from
 * being replayed against another.
 *
 * The header scheme signs a *timestamp* and rejects anything outside a short
 * tolerance, which works because the caller signs at the moment it connects.
 * A URL is different: it is minted once, handed to someone else, and dialed
 * whenever that someone gets around to it — a meeting bot sitting in a waiting
 * room can be twenty minutes. So the minter states an *expiry* instead and
 * accepts that the URL is a bearer credential until then. {@link
 * MAX_HANDSHAKE_TTL_SECONDS} bounds how far out that can be, so a minter
 * cannot issue a URL that never expires.
 *
 * ## Both halves, one owner
 *
 * Minting and verification sit together because they must agree exactly, and
 * both belong to the gateway: it is what Velay hands the public base URL to,
 * what reads the plugin's `webhook_secret`, and what owns the
 * `/webhooks/plugins/` prefix. A plugin that needs one of these URLs asks the
 * gateway for it rather than assembling one, so the secret and the scheme
 * never leave this process.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Query parameter carrying the unix-seconds expiry the signature covers. */
export const HANDSHAKE_EXPIRY_PARAM = "vellum_exp";

/** Query parameter carrying `sha256=<hex>` over {@link handshakeSignedPayload}. */
export const HANDSHAKE_SIGNATURE_PARAM = "vellum_sig";

const SIGNATURE_PREFIX = "sha256=";

/**
 * Longest a minted URL may stay valid. A day is generous for "create a bot
 * now, it dials when admitted" while still bounding how long a leaked URL is
 * worth anything.
 */
export const MAX_HANDSHAKE_TTL_SECONDS = 24 * 60 * 60;

/** Exactly what the HMAC covers. Both ends call this rather than interpolating. */
export function handshakeSignedPayload(
  expirySeconds: number,
  pathname: string,
): string {
  return `${expirySeconds}.${pathname}`;
}

/** `sha256=<hex>` over `payload`. */
export function signHandshakePayload(payload: string, secret: string): string {
  const hex = createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("hex");
  return `${SIGNATURE_PREFIX}${hex}`;
}

/**
 * Constant-time compare of a presented `sha256=<hex>` signature against one
 * computed over `payload`.
 *
 * Buffer byte lengths are compared rather than string lengths: `timingSafeEqual`
 * throws on differing byte lengths, and a non-ASCII presented value can match
 * in UTF-16 code units while diverging in bytes.
 */
export function handshakeSignatureMatches(
  presented: string | null | undefined,
  payload: string,
  secret: string,
): boolean {
  if (!presented || !secret) return false;
  if (!presented.startsWith(SIGNATURE_PREFIX)) return false;

  const presentedBuf = Buffer.from(presented.slice(SIGNATURE_PREFIX.length));
  const expectedBuf = Buffer.from(
    signHandshakePayload(payload, secret).slice(SIGNATURE_PREFIX.length),
  );
  if (presentedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(presentedBuf, expectedBuf);
}

/** Why a signed-query handshake was refused. */
export type HandshakeRejection =
  | "missing"
  | "malformed_expiry"
  | "expired"
  | "ttl_too_long"
  | "bad_signature";

export type HandshakeVerification =
  | { ok: true; expirySeconds: number }
  | { ok: false; reason: HandshakeRejection };

/**
 * Verify the signed-query parameters on an inbound handshake URL.
 *
 * Expiry is checked before the signature because it needs no secret and
 * rejects the common case cheaply. The distinct {@link HandshakeRejection}
 * reasons are for the gateway's logs; a caller is told only that the
 * handshake failed, so the split is not a disclosure.
 *
 * `pathname` is passed in rather than read off `url` so the caller decides
 * what was signed — the gateway signs the public path it serves, which is not
 * always the path it later forwards to.
 */
export function verifySignedQueryHandshake(opts: {
  url: URL;
  pathname: string;
  secret: string;
  nowMs?: number;
}): HandshakeVerification {
  const { url, pathname, secret } = opts;
  const nowMs = opts.nowMs ?? Date.now();

  const rawExpiry = url.searchParams.get(HANDSHAKE_EXPIRY_PARAM);
  const signature = url.searchParams.get(HANDSHAKE_SIGNATURE_PARAM);
  if (!rawExpiry || !signature) {
    return { ok: false, reason: "missing" };
  }

  const expirySeconds = Number(rawExpiry);
  // The canonical spelling is required, not just a parseable one: the minter
  // signs a payload built from the number, so "0123" or "1e9" would otherwise
  // reach the HMAC as a value it never signed.
  if (
    !Number.isSafeInteger(expirySeconds) ||
    expirySeconds <= 0 ||
    rawExpiry !== String(expirySeconds)
  ) {
    return { ok: false, reason: "malformed_expiry" };
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  if (expirySeconds <= nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  // A minter that claims an expiry further out than the scheme allows is
  // refused rather than clamped: clamping would quietly honour a URL nobody
  // agreed to issue.
  if (expirySeconds - nowSeconds > MAX_HANDSHAKE_TTL_SECONDS) {
    return { ok: false, reason: "ttl_too_long" };
  }

  const payload = handshakeSignedPayload(expirySeconds, pathname);
  if (!handshakeSignatureMatches(signature, payload, secret)) {
    return { ok: false, reason: "bad_signature" };
  }

  return { ok: true, expirySeconds };
}

/**
 * Append the signed-query parameters to `url`, in place.
 *
 * The minting half of {@link verifySignedQueryHandshake}. Kept beside it so
 * the payload is constructed once, by one function, for both.
 */
export function signHandshakeUrl(opts: {
  url: URL;
  secret: string;
  ttlSeconds: number;
  nowMs?: number;
}): URL {
  const { url, secret, ttlSeconds } = opts;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("signHandshakeUrl: ttlSeconds must be a positive integer");
  }
  if (ttlSeconds > MAX_HANDSHAKE_TTL_SECONDS) {
    throw new Error(
      `signHandshakeUrl: ttlSeconds exceeds the ${MAX_HANDSHAKE_TTL_SECONDS}s maximum`,
    );
  }
  const nowMs = opts.nowMs ?? Date.now();
  const expirySeconds = Math.floor(nowMs / 1000) + ttlSeconds;
  const payload = handshakeSignedPayload(expirySeconds, url.pathname);

  url.searchParams.set(HANDSHAKE_EXPIRY_PARAM, String(expirySeconds));
  url.searchParams.set(
    HANDSHAKE_SIGNATURE_PARAM,
    signHandshakePayload(payload, secret),
  );
  return url;
}
