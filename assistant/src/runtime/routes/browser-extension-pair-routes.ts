/**
 * Route handler for `POST /v1/browser-extension-pair`.
 *
 * Mints a short-lived, scoped `host_browser_command` capability token for a
 * chrome extension that has proved (via the native messaging helper) it is
 * running locally with an allowlisted extension id.
 *
 * Security properties:
 *   - **Localhost-only**: enforced by both the TCP peer IP (via
 *     `server.requestIP`) and the `Host` header. Non-localhost callers
 *     receive a 403.
 *   - **Origin allowlist**: the body must include `origin` matching a
 *     hard-coded allowlist of known Vellum chrome extension ids. This is a
 *     minimal check; real enforcement happens in the native messaging
 *     helper which vets the extension id that spawned it (PR 7).
 *   - **No auth header required**: the native messaging bootstrap flow
 *     runs before the extension has any token. The localhost + origin
 *     checks are the only gate.
 *
 * Returns `{ token, expiresAt, guardianId }` on success.
 */

import { findGuardianForChannel } from "../../contacts/contact-store.js";
import { getLogger } from "../../util/logger.js";
import { mintHostBrowserCapability } from "../capability-tokens.js";
import { httpError } from "../http-errors.js";
import { isLoopbackAddress } from "../middleware/auth.js";

const log = getLogger("browser-extension-pair");

/** Bun server shape needed for requestIP. */
export type PairServerContext = {
  requestIP(
    req: Request,
  ): { address: string; family: string; port: number } | null;
};

/**
 * Hard-coded allowlist of chrome extension origins permitted to request a
 * capability token. Mirrors the placeholder id used by PR 7's native
 * messaging helper scaffold. Update in tandem with PR 7's
 * `ALLOWED_EXTENSION_IDS` constant before release.
 */
export const ALLOWED_EXTENSION_ORIGINS: ReadonlySet<string> = new Set<string>([
  // TODO: production chrome extension id
  "chrome-extension://fakedevid/",
]);

/**
 * Returns true if the Host header (if present) points at a loopback
 * address. We accept a missing Host header because some HTTP clients
 * (notably node test harnesses) omit it.
 */
function isLoopbackHostHeader(host: string | null): boolean {
  if (!host) return true;
  const hostname = host.split(":")[0]?.toLowerCase() ?? "";
  if (hostname === "localhost") return true;
  if (hostname === "127.0.0.1") return true;
  if (hostname === "::1") return true;
  if (hostname === "[::1]") return true;
  if (hostname.startsWith("127.")) return true;
  return false;
}

/**
 * Resolve the guardian id to bind the capability token to. Phase 2 uses
 * the local vellum guardian principal when one exists, falling back to
 * the string `"local"` for fresh installs that haven't bootstrapped a
 * guardian yet.
 */
function resolveLocalGuardianId(): string {
  try {
    const result = findGuardianForChannel("vellum");
    if (result?.contact.principalId) {
      return result.contact.principalId;
    }
  } catch (err) {
    log.warn(
      { err },
      "Failed to look up local vellum guardian; falling back to 'local'",
    );
  }
  return "local";
}

/**
 * Handle POST /v1/browser-extension-pair.
 *
 * Body: { origin: string }
 * Returns: { token, expiresAt, guardianId }
 */
export async function handleBrowserExtensionPair(
  req: Request,
  server: PairServerContext,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  // Enforce localhost-only via peer IP.
  const peer = server.requestIP(req);
  const peerIp = peer?.address ?? "";
  if (!peerIp || !isLoopbackAddress(peerIp)) {
    log.warn({ peerIp }, "Rejecting browser-extension-pair from non-loopback");
    return httpError("FORBIDDEN", "endpoint is local-only", 403);
  }

  // Secondary check: Host header. Rejects requests that slip past the
  // TCP-level check via proxies that rewrite the peer address.
  const host = req.headers.get("host");
  if (!isLoopbackHostHeader(host)) {
    log.warn(
      { host },
      "Rejecting browser-extension-pair with non-loopback Host header",
    );
    return httpError("FORBIDDEN", "endpoint is local-only", 403);
  }

  // Any `x-forwarded-for` header indicates the request was proxied from a
  // non-local client. Reject — the pair endpoint is strictly machine-local.
  if (req.headers.get("x-forwarded-for")) {
    return httpError("FORBIDDEN", "endpoint is local-only", 403);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return httpError("BAD_REQUEST", "invalid JSON body", 400);
  }

  if (!body || typeof body !== "object") {
    return httpError("BAD_REQUEST", "body must be an object", 400);
  }
  const origin = (body as { origin?: unknown }).origin;
  if (typeof origin !== "string" || origin.length === 0) {
    return httpError("BAD_REQUEST", "origin is required", 400);
  }

  if (!ALLOWED_EXTENSION_ORIGINS.has(origin)) {
    log.warn(
      { origin },
      "Rejecting browser-extension-pair for disallowed origin",
    );
    return httpError("UNAUTHORIZED", "unauthorized origin", 401);
  }

  const guardianId = resolveLocalGuardianId();
  const { token, expiresAt } = mintHostBrowserCapability(guardianId);

  log.info(
    { origin, guardianId, expiresAt },
    "Issued chrome extension capability token",
  );

  return Response.json({ token, expiresAt, guardianId });
}
