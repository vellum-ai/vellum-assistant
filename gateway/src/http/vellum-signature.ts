/**
 * Verification for the `Vellum-Signature` header.
 *
 * The signer computes `HMAC-SHA256(secret, rawBody)` and sends it as
 * `Vellum-Signature: sha256=<hex-digest>`. The scheme is the platform's, but
 * nothing about it is platform-specific — plugin webhook routes verify the
 * same header against the plugin's own secret.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const HEADER_NAME = "vellum-signature";
const PREFIX = "sha256=";

/** Companion header carrying the unix seconds a handshake was signed at. */
export const VELLUM_TIMESTAMP_HEADER = "vellum-timestamp";

/**
 * How stale a signed handshake may be. Matches the Svix tolerance the Resend
 * webhook uses.
 */
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/**
 * What a WebSocket handshake signs.
 *
 * An upgrade has no body, so signing one would otherwise be signing nothing —
 * a static value that stays valid forever once captured. Binding the
 * timestamp and the path instead keeps a captured handshake usable only
 * briefly, and only against the route it was issued for.
 */
export function handshakeSignedPayload(
  timestamp: string,
  pathname: string,
): string {
  return `${timestamp}.${pathname}`;
}

/** True when `timestamp` (unix seconds) is close enough to now. */
export function timestampWithinTolerance(
  timestamp: string,
  nowMs: number = Date.now(),
): boolean {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  const skew = Math.abs(nowMs / 1000 - seconds);
  return skew <= TIMESTAMP_TOLERANCE_SECONDS;
}

/**
 * True when `headers` carries a signature over `rawBody` made with `secret`.
 *
 * Pass the raw bytes when you have them: a decoded string round-trips only
 * for well-formed UTF-8, and a body that is not well-formed would otherwise
 * be hashed after replacement characters had already altered it.
 */
export function verifyVellumSignature(
  headers: Headers,
  rawBody: string | Uint8Array,
  secret: string,
): boolean {
  const signatureHeader = headers.get(HEADER_NAME);
  if (!signatureHeader || !secret) return false;
  if (!signatureHeader.startsWith(PREFIX)) return false;
  const providedHex = signatureHeader.slice(PREFIX.length);

  const hmac = createHmac("sha256", secret);
  if (typeof rawBody === "string") {
    hmac.update(rawBody, "utf8");
  } else {
    hmac.update(rawBody);
  }
  const expected = hmac.digest("hex");

  // Compare Buffer byte lengths — not string .length — to avoid
  // timingSafeEqual throwing on non-ASCII input where UTF-16 code unit
  // count matches but byte length diverges.
  const providedBuf = Buffer.from(providedHex);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;

  return timingSafeEqual(providedBuf, expectedBuf);
}
