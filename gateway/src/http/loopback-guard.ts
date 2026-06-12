/**
 * Shared loopback-only guard for local-machine HTTP endpoints (`/v1/pair`,
 * `/v1/devices`, …). Centralizes the generic "this request must originate from
 * the local machine" checks so every loopback endpoint enforces the SAME
 * boundary and it can't drift between them.
 *
 * Callers run {@link enforceLoopbackOnly} first; any endpoint-specific gating
 * (rate limiting, Origin/interface checks) happens afterward in the handler.
 */

import { getLogger } from "../logger.js";
import { isLoopbackAddress } from "../util/is-loopback-address.js";
import { VELAY_FORWARDED_HEADER } from "../velay/bridge-utils.js";
import { requestArrivedViaEdgeProxy } from "./edge-forwarded-header.js";

const log = getLogger("loopback-guard");

/** JSON error response in the shared `{ error: { code, message } }` shape. */
export function errorResponse(
  code: string,
  message: string,
  status: number,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

/** Extract the hostname from a `Host` header value (strips port; handles `[ipv6]`). */
export function parseHostHeader(raw: string): string | null {
  if (raw.length === 0) return null;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end < 0) return null;
    const after = raw.substring(end + 1);
    if (after.length > 0 && !after.startsWith(":")) return null;
    return raw.substring(1, end);
  }
  const firstColon = raw.indexOf(":");
  if (firstColon < 0) return raw;
  const secondColon = raw.indexOf(":", firstColon + 1);
  if (secondColon >= 0) {
    return raw;
  }
  return raw.substring(0, firstColon);
}

/** True if the `Host` header is absent or names a loopback address/localhost. */
export function isLoopbackHostHeader(host: string | null): boolean {
  if (!host) return true;
  const parsed = parseHostHeader(host);
  if (parsed === null) return false;
  const hostname = parsed.toLowerCase();
  if (hostname === "localhost") return true;
  return isLoopbackAddress(hostname);
}

function auditDeny(
  req: Request,
  peerIp: string,
  auditTag: string,
  reason: string,
): void {
  log.warn(
    {
      audit: `${auditTag}-denied`,
      peerIp,
      host: req.headers.get("host"),
      origin: req.headers.get("origin"),
      reason,
    },
    `${auditTag}_denied: ${reason}`,
  );
}

/**
 * Enforce that a request originates from the local machine. Returns a 403
 * `Response` if any check fails, or `null` if the request is loopback-local.
 *
 * Rejects, in order: Velay-bridged requests, requests forwarded by the
 * self-hosted nginx edge, non-loopback peer IPs, non-loopback `Host` headers,
 * and any request carrying `X-Forwarded-For`.
 */
export function enforceLoopbackOnly(
  req: Request,
  clientIp: string,
  auditTag = "loopback",
): Response | null {
  // The Velay bridge injects this header on every forwarded request; a Velay
  // client cannot strip it.
  if (req.headers.get(VELAY_FORWARDED_HEADER)) {
    auditDeny(req, clientIp, auditTag, "velay_bridged");
    return errorResponse("FORBIDDEN", "endpoint is local-only", 403);
  }

  // The self-hosted nginx edge (e.g. the SPA over an ngrok tunnel) sets this
  // marker unconditionally; it cannot be spoofed or stripped by the client.
  if (requestArrivedViaEdgeProxy(req)) {
    auditDeny(req, clientIp, auditTag, "edge_proxy_forwarded");
    return errorResponse("FORBIDDEN", "endpoint is local-only", 403);
  }

  if (!clientIp || !isLoopbackAddress(clientIp)) {
    auditDeny(req, clientIp, auditTag, "non_loopback_peer");
    return errorResponse("FORBIDDEN", "endpoint is local-only", 403);
  }

  if (!isLoopbackHostHeader(req.headers.get("host"))) {
    auditDeny(req, clientIp, auditTag, "non_loopback_host_header");
    return errorResponse("FORBIDDEN", "endpoint is local-only", 403);
  }

  if (req.headers.get("x-forwarded-for")) {
    auditDeny(req, clientIp, auditTag, "x_forwarded_for_present");
    return errorResponse("FORBIDDEN", "endpoint is local-only", 403);
  }

  return null;
}

/**
 * Reject any request carrying an `Origin` header. Host-CLI loopback endpoints
 * (device management, cli pairing) are only ever called by a terminal process,
 * which never sends an Origin; a present Origin means a browser/WebView is
 * driving the request. Because the gateway reflects CORS for matched
 * `*.vellum.local` WebView origins, such JS could otherwise reach these
 * loopback-only endpoints from inside the WebView sandbox (read device hashes,
 * revoke devices, mint tokens). This closes that vector — mirroring the
 * `/v1/pair` cli-interface guard. Returns a 403 `Response` if an Origin is
 * present, or `null` if absent.
 */
export function rejectBrowserOrigin(
  req: Request,
  clientIp: string,
  auditTag = "loopback",
): Response | null {
  if (req.headers.get("origin")) {
    auditDeny(req, clientIp, auditTag, "browser_origin");
    return errorResponse("FORBIDDEN", "endpoint is local-only", 403);
  }
  return null;
}
