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
 *   - `GET  /v1/remote-web/pairing-requests`          list pending challenges
 *       (loopback-only)
 *   - `POST /v1/remote-web/pairing-requests/approve`  approve by request id
 *       (loopback-only)
 *   - `POST /v1/remote-web/pairing-requests/deny`     deny (delete) by request id
 *       (loopback-only)
 *
 * These shapes mirror those handlers' request/response bodies exactly so the
 * gateway, the `vellum pair` CLI (`cli/src/commands/pair.ts`), and the web SPA
 * (`clients/web/src/lib/auth/remote-gateway-session.ts`) share one definition
 * and cannot silently drift.
 *
 * Timestamps are ISO-8601 strings — every gateway response serializes them via
 * `Date#toISOString()`.
 */

/**
 * Pairing-challenge TTL in milliseconds (10 minutes): the gateway's challenge
 * store enforces it and the `vellum pair` CLI renders it in user-facing copy.
 */
export const REMOTE_WEB_PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

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

/**
 * One pending challenge as shown on a host approval surface.
 *
 * The requesting device already sees the plaintext `userCode` in its own
 * challenge response ({@link RemoteWebPairingChallengeResponse.userCode});
 * the loopback-gated list route is the only host-side re-exposure. Displaying
 * it there is what lets the approver match the code against the requesting
 * device's screen: the device-flow anti-phishing binding.
 */
export interface RemoteWebPairingRequestSummary {
  /** Opaque server-side id used to approve or deny this request. */
  requestId: string;
  /** The human-readable code the requesting device is displaying (e.g. "ABCD-EFGH"). */
  userCode: string;
  /** Public base URL the challenge was minted for. */
  publicBaseUrl: string;
  /** ISO-8601 instant the challenge was minted. */
  requestedAt: string;
  /** ISO-8601 instant the challenge expires. */
  expiresAt: string;
  /**
   * Client IP of the mint request: the loopback/host address when minted
   * locally, or the edge-observed client address when the mint arrived
   * through the nginx tunnel edge (which stamps it via `proxy_set_header`,
   * so a remote client cannot smuggle a value).
   */
  requesterIp: string;
  /** User-Agent header of the mint request, or null when absent. */
  requesterUserAgent: string | null;
  /**
   * Whether the mint arrived through the public tunnel edge rather than the
   * host itself.
   */
  viaEdgeProxy: boolean;
}

/** `GET /v1/remote-web/pairing-requests` success response body (200). */
export interface RemoteWebPairingRequestListResponse {
  requests: RemoteWebPairingRequestSummary[];
}

/**
 * Request body for the pairing-request approve and deny routes. The approve
 * route's success body reuses {@link RemoteWebPairingVerificationResponse}.
 */
export interface RemoteWebPairingRequestActionRequest {
  requestId: string;
}

/** `POST /v1/remote-web/pairing-requests/deny` success response body (200). */
export interface RemoteWebPairingRequestDenyResponse {
  status: "denied";
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
export type PublicBaseUrlRejection =
  | "unparseable"
  | "loopback"
  | "non-https"
  | "service-website";

export type PublicBaseUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: PublicBaseUrlRejection };

/**
 * Hosts that are a tunnel/ingress vendor's own website, not a user's assistant
 * endpoint. These are the tunnel vendors our docs mention, and their sites are
 * exactly where a lost user grabs a URL from — e.g. a Tailscale admin invite
 * link (`login.tailscale.com/admin/invite/…`), which is https and non-loopback
 * and so clears every other check. Pairing refuses them with a targeted message
 * rather than minting a challenge the scanning device can never reach.
 */
export const TUNNEL_PROVIDER_WEBSITE_HOSTS = [
  "login.tailscale.com",
  "tailscale.com",
  "www.tailscale.com",
  "ngrok.com",
  "dashboard.ngrok.com",
  "dash.cloudflare.com",
  "cloudflare.com",
  "www.cloudflare.com",
] as const;

/**
 * A URL whose exact host is a tunnel/ingress vendor's own website (see
 * {@link TUNNEL_PROVIDER_WEBSITE_HOSTS}). Exact-host only: a user's real
 * Tailscale endpoint (`*.ts.net`) or Cloudflare-fronted domain is never a
 * listed host, so a legitimate address is never mistaken for a vendor site.
 */
export function isTunnelProviderWebsiteUrl(url: string): boolean {
  let hostname: string;
  try {
    // WHATWG URL lowercases the hostname during parsing.
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return (TUNNEL_PROVIDER_WEBSITE_HOSTS as readonly string[]).includes(
    hostname,
  );
}

/**
 * The display name of the tunnel/ingress vendor a service-website URL points
 * at (`"Tailscale"` / `"ngrok"` / `"Cloudflare"`), or null when the host is not
 * a known vendor site. Drives the "This is <Name>'s website" pairing guidance.
 */
export function tunnelProviderWebsiteName(url: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  if (
    !(TUNNEL_PROVIDER_WEBSITE_HOSTS as readonly string[]).includes(hostname)
  ) {
    return null;
  }
  if (hostname.includes("tailscale")) return "Tailscale";
  if (hostname.includes("ngrok")) return "ngrok";
  if (hostname.includes("cloudflare")) return "Cloudflare";
  return null;
}

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
export function normalizePairingBaseUrl(value: string): string {
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
    normalized = normalizePairingBaseUrl(raw);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (isLoopbackPublicUrl(normalized)) {
    return { ok: false, reason: "loopback" };
  }
  if (isTunnelProviderWebsiteUrl(normalized)) {
    return { ok: false, reason: "service-website" };
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

/**
 * Base that makes a relative pairing link parseable. Only the query and
 * fragment are read off the result, so it never reaches a caller.
 */
const RELATIVE_PAIRING_LINK_BASE = "https://pairing.invalid";

/** The device/user codes a pairing link can carry. */
export interface RemoteWebPairingParams {
  deviceCode: string | null;
  userCode: string | null;
}

function firstParam(
  params: URLSearchParams,
  ...names: string[]
): string | null {
  for (const name of names) {
    const value = params.get(name)?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

/**
 * Query parameters merged with fragment parameters, query winning on a clash.
 * Pairing links carry the device code in the fragment so it never reaches the
 * wire, but hand-assembled links put it in the query.
 */
function pairingLinkParams(url: URL): URLSearchParams {
  const merged = new URLSearchParams(url.search);
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  for (const [key, value] of new URLSearchParams(hash)) {
    if (!merged.has(key)) {
      merged.set(key, value);
    }
  }
  return merged;
}

/**
 * Read the pairing codes off a link, accepting either casing (`device_code` /
 * `deviceCode`) from either the query string or the fragment. Relative values
 * are accepted so a router can pass `pathname + search + hash` straight in.
 */
export function parseRemoteWebPairingParams(
  value: string | URL,
): RemoteWebPairingParams {
  const url =
    typeof value === "string"
      ? new URL(value, RELATIVE_PAIRING_LINK_BASE)
      : value;
  const params = pairingLinkParams(url);
  return {
    deviceCode: firstParam(params, "deviceCode", "device_code"),
    userCode: firstParam(params, "userCode", "user_code"),
  };
}

/** Outcome of {@link parsePairingAddress}. */
export type ParsePairingAddressResult =
  | { ok: true; publicBaseUrl: string; deviceCode: string | null }
  | { ok: false; reason: PublicBaseUrlRejection };

/**
 * The inverse of {@link buildRemoteWebPairingUrl}: what a pasted pairing
 * address means. A full pairing link yields its base plus the device code it
 * carries; a bare `https://host` address yields a null device code, leaving
 * the caller to mint its own challenge. The base goes through
 * {@link resolvePublicBaseUrl}, so loopback, non-https, and tunnel-vendor
 * websites are refused with the same reasons every other pairing surface
 * reports.
 */
export function parsePairingAddress(raw: string): ParsePairingAddressResult {
  const resolved = resolvePublicBaseUrl(raw);
  if (!resolved.ok) {
    return resolved;
  }
  return {
    ok: true,
    publicBaseUrl: resolved.url,
    deviceCode: parseRemoteWebPairingParams(raw).deviceCode,
  };
}
