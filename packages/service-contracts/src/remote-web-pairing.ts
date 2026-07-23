/**
 * Wire contracts for the remote-web pairing flow — the RFC 8628-style
 * device-code exchange that connects a browser (or the iOS app) to a
 * self-hosted assistant over its public ingress URL.
 *
 * The gateway routes are the authoritative serving side:
 *   - `POST /v1/remote-web/pairing-challenge`     mint a challenge
 *       (`gateway/src/http/routes/remote-web-pairing-challenge.ts`,
 *        `gateway/src/remote-web/pairing-challenge-store.ts`)
 *   - `POST /v1/remote-web/pairing-verification`  approve by user code
 *       (`gateway/src/http/routes/remote-web-pairing-verification.ts`)
 *   - `POST /v1/remote-web/pairing-token`         poll + exchange device code
 *       (`gateway/src/http/routes/remote-web-pairing-token.ts`)
 *
 * These shapes mirror those handlers' request/response bodies exactly so the
 * gateway, the `vellum pair` CLI (`cli/src/commands/pair.ts`), and the web SPA
 * (`clients/web/src/lib/auth/remote-gateway-session.ts`) share one definition
 * and cannot silently drift.
 *
 * Timestamps are ISO-8601 strings — every gateway response serializes them via
 * `Date#toISOString()`.
 */

/** `POST /v1/remote-web/pairing-challenge` request body. */
export interface RemoteWebPairingChallengeRequest {
  /** Public https base URL the scanning device can reach the assistant at. */
  publicBaseUrl: string;
}

/** `POST /v1/remote-web/pairing-challenge` success response body (200). */
export interface RemoteWebPairingChallengeResponse {
  /** Opaque secret the paired device exchanges for a token. */
  deviceCode: string;
  /** Short human-readable code the host approves out of band. */
  userCode: string;
  /** URL the device opens to complete pairing. */
  verificationUri: string;
  /** ISO-8601 instant the challenge expires. */
  expiresAt: string;
  /** Seconds until the challenge expires. */
  expiresInSeconds: number;
  /** Recommended poll interval (seconds) for the token-exchange endpoint. */
  intervalSeconds: number;
}

/** `POST /v1/remote-web/pairing-verification` request body. */
export interface RemoteWebPairingVerificationRequest {
  /** The `userCode` from the challenge, entered/scanned on the host. */
  userCode: string;
}

/**
 * `POST /v1/remote-web/pairing-verification` success response body (200).
 *
 * The gateway maps the `expired` / `invalid` outcomes to error responses, so
 * the only success shape on the wire is the approved variant.
 */
export interface RemoteWebPairingVerificationResponse {
  status: "approved";
  verificationUri: string;
  /** ISO-8601 instant the approved challenge expires. */
  expiresAt: string;
}

/** `POST /v1/remote-web/pairing-token` request body. */
export interface RemoteWebPairingTokenRequest {
  /** The `deviceCode` from the challenge. */
  deviceCode: string;
}

/**
 * `POST /v1/remote-web/pairing-token` still-pending response body (202) — the
 * challenge exists but has not been approved yet, so the client keeps polling.
 */
export interface RemoteWebPairingTokenPendingResponse {
  status: "pending";
  /** ISO-8601 instant the challenge expires. */
  expiresAt: string;
  /** Recommended poll interval (seconds) before the next exchange attempt. */
  intervalSeconds: number;
}

/**
 * `POST /v1/remote-web/pairing-token` approved response body (200) — carries
 * the minted browser session credentials. The refresh token is delivered out
 * of band as an `HttpOnly` cookie, not in this body.
 */
export interface RemoteWebPairingTokenApprovedResponse {
  status: "approved";
  accessToken: string;
  /** ISO-8601 instant the access token expires. */
  accessTokenExpiresAt: string;
  /** ISO-8601 instant after which the client should refresh the session. */
  refreshAfter: string;
  guardianId: string;
  assistantId: string;
}

/** Union of the two terminal `pairing-token` response bodies. */
export type RemoteWebPairingTokenResponse =
  | RemoteWebPairingTokenPendingResponse
  | RemoteWebPairingTokenApprovedResponse;

// ── Shared pairing URL helpers ──────────────────────────────────────────────
//
// Every surface that mints a pairing (the `vellum pair --qr` CLI, the web
// settings "Pair a device" card) must accept the same public URLs and build
// the same scannable links. The helpers are environment-neutral (WHATWG URL
// only) so both Node and browser callers share one implementation.

/** Why a public base URL can't be advertised in a pairing challenge. */
export type PublicBaseUrlRejection = "unparseable" | "loopback" | "non-https";

export type PublicBaseUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: PublicBaseUrlRejection };

/**
 * A loopback URL — `localhost`, `[::1]`, or `127.x.x.x`. A pairing link that
 * encodes a loopback address is unreachable from the scanning device.
 */
export function isLoopbackPublicUrl(url: string): boolean {
  try {
    // WHATWG URL canonicalizes hostnames, so IPv6 loopback is always "[::1]".
    const hostname = new URL(url).hostname;
    return (
      hostname === "localhost" ||
      hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Normalize an address to the public base a scanning device opens:
 * query/hash stripped, the `assistant` path segment (and everything after it)
 * removed so a pasted pair-page URL collapses to its base, and trailing
 * slashes trimmed. Throws if the value is not a parseable URL.
 */
export function normalizePublicBaseUrl(value: string): string {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  const parts = url.pathname.split("/").filter(Boolean);
  const assistantIndex = parts.indexOf("assistant");
  if (assistantIndex >= 0) {
    parts.splice(assistantIndex);
  }
  url.pathname = parts.length ? `/${parts.join("/")}` : "/";
  return url.toString().replace(/\/+$/, "");
}

/**
 * Resolve an address to the public https base URL to advertise in a pairing
 * challenge, or report why it can't be used. Loopback and non-https links are
 * refused with a specific reason callers turn into their own guidance.
 */
export function resolvePublicBaseUrl(raw: string): PublicBaseUrlResult {
  let normalized: string;
  try {
    normalized = normalizePublicBaseUrl(raw);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (isLoopbackPublicUrl(normalized)) {
    return { ok: false, reason: "loopback" };
  }
  if (new URL(normalized).protocol !== "https:") {
    return { ok: false, reason: "non-https" };
  }
  return { ok: true, url: normalized };
}

/**
 * The scannable pair URL: the challenge's verification URI with the device
 * code carried in the fragment (`#device_code=…`), matching what the pair
 * page reads on load. Fragments never reach the wire.
 */
export function buildRemoteWebPairingUrl(
  challenge: Pick<
    RemoteWebPairingChallengeResponse,
    "verificationUri" | "deviceCode"
  >,
): string {
  const url = new URL(challenge.verificationUri);
  url.hash = new URLSearchParams({
    device_code: challenge.deviceCode,
  }).toString();
  return url.toString();
}
