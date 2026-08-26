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
 *       (loopback-only)
 *   - `POST /v1/remote-web/pairing-token`         poll + exchange device code
 *       (`gateway/src/http/routes/remote-web-pairing-token.ts`): a browser
 *        receives its refresh token as an `HttpOnly` cookie; a request that
 *        carries a `deviceId` receives a device-bound one in the body instead
 *   - `GET  /v1/remote-web/pairing-requests`          list pending challenges
 *       (loopback-only)
 *   - `POST /v1/remote-web/pairing-requests/approve`  approve by request id
 *       (loopback-only)
 *   - `POST /v1/remote-web/pairing-requests/deny`     deny (delete) by request id
 *       (loopback-only)
 *
 * These shapes mirror those handlers' request/response bodies exactly so the
 * gateway, the `vellum pair` CLI (`cli/src/commands/pair.ts`), the host-side
 * pairing sessions (`packages/local-mode/src/pair.ts`), and the web SPA
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

/**
 * Platforms a device-bound pairing exchange may declare for itself. The value
 * is what the host's `Paired devices` list renders for the new pairing.
 */
export const REMOTE_WEB_PAIRING_PLATFORMS = [
  "cli",
  "desktop",
  "ios",
  "android",
] as const;

export type RemoteWebPairingPlatform =
  (typeof REMOTE_WEB_PAIRING_PLATFORMS)[number];

/** Platform recorded when an exchange names none the gateway recognizes. */
export const DEFAULT_REMOTE_WEB_PAIRING_PLATFORM: RemoteWebPairingPlatform =
  "desktop";

/**
 * A requested platform coerced to a known value. The pairing-token route is
 * publicly reachable and the platform renders verbatim in the host's
 * paired-devices list, so an unrecognized value never reaches the DB.
 */
export function resolveRemoteWebPairingPlatform(
  raw: unknown,
): RemoteWebPairingPlatform {
  return (
    REMOTE_WEB_PAIRING_PLATFORMS.find((platform) => platform === raw) ??
    DEFAULT_REMOTE_WEB_PAIRING_PLATFORM
  );
}

/** `POST /v1/remote-web/pairing-token` request body. */
export interface RemoteWebPairingTokenRequest {
  /** The `deviceCode` from the challenge. */
  deviceCode: string;
  /**
   * Client-generated device id, sent only by a trusted host completing the
   * exchange for itself. It switches the gateway to a device-bound, per-device
   * revocable credential whose refresh token comes back in the response body.
   * Browsers omit it and keep the cookie delivery.
   */
  deviceId?: string;
  /** Platform to record for the device. Ignored without a `deviceId`. */
  platform?: RemoteWebPairingPlatform;
  /**
   * Optional self-reported device name, for example "Vellum iOS app". The gateway
   * stores it verbatim (capped) and never trusts it for authorization. Absent from
   * clients that predate this field.
   */
  clientReportedName?: string;
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
 * the minted session credentials. A browser exchange (no `deviceId`) receives
 * its refresh token out of band as an `HttpOnly` cookie and so omits the two
 * refresh fields below; a device-bound exchange receives it here instead.
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
  /** Device-bound refresh token, present only for a `deviceId` exchange. */
  refreshToken?: string;
  /** ISO-8601 instant the device-bound refresh token expires. */
  refreshTokenExpiresAt?: string;
}

/** Union of the two terminal `pairing-token` response bodies. */
export type RemoteWebPairingTokenResponse =
  | RemoteWebPairingTokenPendingResponse
  | RemoteWebPairingTokenApprovedResponse;

// ── Shared pairing URL helpers ──────────────────────────────────────────────
//
// Every surface that mints a pairing (the `vellum pair` CLI, the web
// settings "Pair a device" card) must accept the same public URLs and build
// the same scannable links. The helpers are environment-neutral (WHATWG URL
// only) so both Node and browser callers share one implementation.

/** Why a public base URL can't be advertised in a pairing challenge. */
export type PublicBaseUrlRejection =
  | "unparseable"
  | "loopback"
  | "private-address"
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
 * A hostname with any trailing DNS root dot removed. `example.com.` and
 * `example.com` name the same host, and a resolver reads `localhost.` as the
 * loopback name, so every host comparison below runs on the stripped form.
 * Bracketed IPv6 literals never carry one.
 */
function hostnameWithoutRootDot(hostname: string): string {
  return hostname.replace(/\.+$/, "");
}

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
    hostname = hostnameWithoutRootDot(new URL(url).hostname);
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
    hostname = hostnameWithoutRootDot(new URL(url).hostname);
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
 * A URL's comparable host: root dot stripped and IPv6 brackets removed, or
 * null when the value is not a parseable URL.
 */
function comparableHost(url: string): string | null {
  try {
    // WHATWG URL canonicalizes hostnames: IPv6 loopback is always "[::1]", a
    // bare "0" is "0.0.0.0", and encoded IPv4 literals become dotted quads.
    return hostnameWithoutRootDot(new URL(url).hostname).replace(
      /^\[|\]$/g,
      "",
    );
  } catch {
    return null;
  }
}

/**
 * Hosts that reach the dialing machine without a resolver having to agree:
 * `localhost`, `127.x.x.x`, `[::1]`, and the wildcard binds `0.0.0.0` / `[::]`,
 * in their dotted, hex, and IPv4-mapped spellings.
 */
function isDnsIndependentLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    // A wildcard host reaches a local listener when dialed, so it counts as
    // local for the pairing and refresh-channel guards alike.
    host === "0.0.0.0" ||
    host === "0" ||
    host === "::" ||
    host === "0:0:0:0:0:0:0:0" ||
    // IPv4-mapped loopback and wildcard, in dotted and hex encodings.
    /^(?:0:0:0:0:0|:):ffff:127(?:\.\d{1,3}){3}$/.test(host) ||
    /^(?:0:0:0:0:0|:):ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host) ||
    /^(?:0:0:0:0:0|:):ffff:0\.0\.0\.0$/.test(host) ||
    /^(?:0:0:0:0:0|:):ffff:0:0$/.test(host)
  );
}

/**
 * A URL that reaches a listener on the machine dialing it, judged wide: the
 * literals {@link isDnsIndependentLoopbackHost} covers PLUS the whole reserved
 * `localhost` namespace (RFC 6761, so `foo.localhost` counts). A pairing link
 * that encodes one is unreachable from the scanning device, and a host that
 * POSTs to one is calling a service on its own machine.
 *
 * This is the one loopback predicate the whole pairing path reads (the pasted
 * address, and the gatewayUrl an import registers), so the same address class
 * can never be refused by one entry point and accepted by another. Every read
 * of it REFUSES the address it matches, which is why it is the wide one.
 * A guard that GRANTS something to loopback reads
 * {@link isDnsIndependentLoopbackUrl} instead.
 */
export function isLoopbackPublicUrl(url: string): boolean {
  const host = comparableHost(url);
  if (host === null) {
    return false;
  }
  return host.endsWith(".localhost") || isDnsIndependentLoopbackHost(host);
}

/**
 * A URL that reaches this machine whatever the resolver does, judged narrow:
 * exact `localhost` and the loopback/wildcard IP literals, and NOT the
 * reserved `.localhost` namespace. RFC 6761 says a resolver should map that
 * namespace to loopback, but glibc does not by default, so `evil.localhost`
 * is an ordinary DNS name that can answer with any address at all.
 *
 * Read this wherever loopback EARNS a privilege a public host does not get,
 * such as accepting a plaintext channel as confidential; read the wider
 * {@link isLoopbackPublicUrl} wherever loopback is refused. Both directions
 * then fail safe on a name that only might be local.
 */
export function isDnsIndependentLoopbackUrl(url: string): boolean {
  const host = comparableHost(url);
  return host !== null && isDnsIndependentLoopbackHost(host);
}

/** Canonical dotted-quad as its four octets, or null when it is not one. */
function parseIpv4Literal(hostname: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) {
    return null;
  }
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** Bracketed IPv6 literal as its eight 16-bit pieces, or null. */
function parseIpv6Literal(hostname: string): number[] | null {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) {
    return null;
  }
  const halves = hostname.slice(1, -1).split("::");
  if (halves.length > 2) {
    return null;
  }
  const toPieces = (part: string): number[] | null => {
    if (!part) {
      return [];
    }
    const pieces: number[] = [];
    const labels = part.split(":");
    for (const [index, label] of labels.entries()) {
      // A trailing dotted-quad is legal IPv6 text. The WHATWG serializer never
      // emits one, but a hand-built literal can still reach this parser.
      if (index === labels.length - 1 && label.includes(".")) {
        const octets = parseIpv4Literal(label);
        if (!octets) {
          return null;
        }
        pieces.push(
          ((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
          ((octets[2] ?? 0) << 8) | (octets[3] ?? 0),
        );
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(label)) {
        return null;
      }
      pieces.push(Number.parseInt(label, 16));
    }
    return pieces;
  };
  const head = toPieces(halves[0] ?? "");
  const tail = halves.length === 2 ? toPieces(halves[1] ?? "") : [];
  if (!head || !tail) {
    return null;
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const gap = 8 - head.length - tail.length;
  return gap >= 1 ? [...head, ...Array<number>(gap).fill(0), ...tail] : null;
}

/**
 * IPv4 ranges that are not publicly routable, judged from the four octets of a
 * canonical dotted-quad. Loopback (127/8) is included so the predicate is
 * complete on its own; `resolvePublicBaseUrl` still reports it as `loopback`
 * because it checks that first.
 *
 * 100.64.0.0/10 is DELIBERATELY ABSENT. Tailscale hands out CGNAT addresses
 * from that range and a Tailscale endpoint is a supported pairing target.
 */
function isPrivateIpv4(octets: readonly number[]): boolean {
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  const c = octets[2] ?? 0;
  return (
    a === 0 || // 0/8 "this network"
    a === 10 || // 10/8 private
    a === 127 || // 127/8 loopback
    (a === 169 && b === 254) || // 169.254/16 link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12 private
    (a === 192 && b === 0 && c === 0) || // 192.0.0/24 protocol assignments
    (a === 192 && b === 168) || // 192.168/16 private
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmarking
    a >= 224 // 224/4 multicast, 240/4 reserved, 255.255.255.255 broadcast
  );
}

/**
 * A URL whose hostname is an IP literal outside publicly routable space:
 * private, loopback, link-local (which is where the cloud instance metadata
 * endpoint 169.254.169.254 lives), multicast, or reserved, in either address
 * family. Pairing POSTs to whatever address the user pasted, so a literal
 * aimed at the host's own network is refused before any request is made.
 *
 * Only literals written directly in the address are checked. Hostnames are
 * NEVER resolved and resolved addresses are NEVER filtered, deliberately:
 * Tailscale endpoints (`*.ts.net`) are a supported pairing target and resolve
 * into the 100.64.0.0/10 CGNAT range, so post-DNS filtering would refuse them
 * outright. It would also be TOCTOU-prone, since a name can resolve
 * differently between the check and the connection.
 */
export function isPrivateNetworkPublicUrl(url: string): boolean {
  let hostname: string;
  try {
    // WHATWG URL canonicalizes IP literals: decimal, octal, and hex IPv4 forms
    // collapse to a dotted-quad, and IPv6 to a bracketed lowercase literal.
    hostname = hostnameWithoutRootDot(new URL(url).hostname);
  } catch {
    return false;
  }
  const ipv4 = parseIpv4Literal(hostname);
  if (ipv4) {
    return isPrivateIpv4(ipv4);
  }
  const ipv6 = parseIpv6Literal(hostname);
  if (!ipv6) {
    return false;
  }
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) literals carry
  // an IPv4 destination, so they are unwrapped and judged as IPv4.
  const low = ipv6[5] ?? 0;
  if (
    ipv6.slice(0, 5).every((piece) => piece === 0) &&
    (low === 0xffff || low === 0)
  ) {
    const mapped = ipv6[6] ?? 0;
    const trailing = ipv6[7] ?? 0;
    return isPrivateIpv4([
      mapped >> 8,
      mapped & 0xff,
      trailing >> 8,
      trailing & 0xff,
    ]);
  }
  const top = ipv6[0] ?? 0;
  return (
    (top & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
    (top & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (top & 0xff00) === 0xff00 // ff00::/8 multicast
  );
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
 * challenge, or report why it can't be used. Loopback, private-network IP
 * literals, and non-https links are refused with a specific reason callers
 * turn into their own guidance.
 *
 * Hosts POST to this address during pairing, so the refusals are the SSRF
 * containment for every pairing surface. See
 * {@link isPrivateNetworkPublicUrl} for why resolved addresses are left alone.
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
  if (isPrivateNetworkPublicUrl(normalized)) {
    return { ok: false, reason: "private-address" };
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
 * {@link resolvePublicBaseUrl}, so loopback, private-network literals,
 * non-https, and tunnel-vendor websites are refused with the same reasons
 * every other pairing surface reports.
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

/**
 * What a pairing attempt failed on, for callers picking recovery copy. Every
 * pairing surface reports one of these: the host-side sessions in
 * `@vellumai/local-mode`, the Electron bridge, the desktop connect dialog, and
 * the `vellum connect import` CLI.
 */
export type PairingFailureReason =
  /** The pasted address is not a usable assistant address. */
  | "invalid-address"
  /** No live session for this handle: it was cancelled or never existed. */
  | "unknown-session"
  /** The device code expired, was denied, or was already spent. */
  | "expired"
  /** The assistant could not be reached. */
  | "unreachable"
  /**
   * The assistant refused the request with a status that left the device code
   * exchangeable, so the same session is worth another attempt.
   */
  | "gateway-retryable"
  /**
   * The assistant answered, but with a reply this device cannot use. The code
   * behind it is spent or unknowable, so the attempt is settled.
   */
  | "gateway"
  /** The credentials arrived, but registering them locally was refused. */
  | "import"
  /**
   * The local destination was refused BEFORE the exchange, so the one-time
   * code is untouched and the session is still pollable. Only a caller that
   * changes what it asked for (a different `name`) can get past it, so it is
   * not worth another identical attempt.
   */
  | "import-precheck";

/**
 * Every reason, mapped to whether another attempt against the same session can
 * still succeed. Two classes leave the device code exchangeable host-side:
 *
 * - `unreachable`, the transport class (a thrown fetch, a timeout, a refused
 *   redirect, a body that errored mid-stream). Nothing reached the assistant,
 *   so the session and the code are untouched.
 * - `gateway-retryable`, a non-200 the assistant answered with. The gateway
 *   releases the challenge before a repairable failure (a transient error, or
 *   the `GUARDIAN_REPAIR_REQUIRED` 503), so the same code stays exchangeable.
 *
 * Everything else ends the attempt. `invalid-address` and `unknown-session`
 * cannot resolve by waiting; `expired` and `import` mean the one-time code is
 * already spent; `gateway` means the assistant answered with something this
 * device cannot use (an over-cap body, credentials it cannot persist, a 200
 * that is not a pairing reply), past which the code is spent rather than
 * released; and `import-precheck` refused the local destination before the
 * exchange, so an identical attempt is refused identically.
 *
 * `import-precheck` is the one of those that leaves the SESSION alive, which
 * is a separate question from whether to retry: see
 * {@link pairingSessionSurvives}.
 *
 * The `satisfies` clause keeps the map exhaustive, so a new reason does not
 * compile until it is classified here.
 */
const PAIRING_REASON_RETRYABLE = {
  "invalid-address": false,
  "unknown-session": false,
  expired: false,
  unreachable: true,
  "gateway-retryable": true,
  gateway: false,
  import: false,
  "import-precheck": false,
} satisfies Record<PairingFailureReason, boolean>;

/** The reasons {@link isRetryablePairingReason} accepts. */
export const RETRYABLE_PAIRING_REASONS: ReadonlySet<PairingFailureReason> =
  new Set(
    (Object.keys(PAIRING_REASON_RETRYABLE) as PairingFailureReason[]).filter(
      (reason) => PAIRING_REASON_RETRYABLE[reason],
    ),
  );

/**
 * Whether a refused pairing step is worth another attempt. An unlabelled
 * failure reads as settled, so a host too old to name a reason ends the
 * attempt rather than being spun against until the code expires.
 */
export function isRetryablePairingReason(
  reason: PairingFailureReason | null | undefined,
): boolean {
  return reason != null && RETRYABLE_PAIRING_REASONS.has(reason);
}

/**
 * Every reason, mapped to whether the pairing session it came from is still
 * live host-side. A caller holding the handle reads this to decide whether to
 * release the session: releasing a live one throws away a device code that is
 * still good and costs the user a fresh pairing link.
 *
 * This is deliberately NOT the retryable map. `import-precheck` is the reason
 * the two disagree on: nothing was spent and the same handle still polls, but
 * only once the caller changes the name it asked for, so a blind retry is
 * futile while dropping the session is destructive.
 *
 * `invalid-address` never had a session to begin with, so it reads false the
 * same way a dead one does: there is nothing to hold onto either way.
 */
const PAIRING_REASON_SESSION_LIVE = {
  "invalid-address": false,
  "unknown-session": false,
  expired: false,
  unreachable: true,
  "gateway-retryable": true,
  gateway: false,
  import: false,
  "import-precheck": true,
} satisfies Record<PairingFailureReason, boolean>;

/**
 * Whether the session behind a refused pairing step is still pollable. An
 * unlabelled failure reads as settled, so a host too old to name a reason has
 * its session released rather than left to time out.
 */
export function pairingSessionSurvives(
  reason: PairingFailureReason | null | undefined,
): boolean {
  return reason != null && PAIRING_REASON_SESSION_LIVE[reason] === true;
}
