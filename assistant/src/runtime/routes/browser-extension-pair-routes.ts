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
 *   - **Origin allowlist**: the body must include `extensionOrigin`
 *     matching a hard-coded allowlist of known Vellum chrome extension
 *     ids. This is a minimal check; real enforcement happens in the
 *     native messaging helper which vets the extension id that spawned
 *     it (PR 7).
 *   - **No auth header required**: the native messaging bootstrap flow
 *     runs before the extension has any token. The localhost + origin
 *     checks are the only gate.
 *
 * Request body:  `{ extensionOrigin: string }` (also accepts the legacy
 *                 `{ origin: string }` for backwards compatibility).
 * Response body: `{ token, expiresAt, guardianId }` — `expiresAt` is an
 *                 ISO 8601 timestamp string matching what the native
 *                 messaging helper validates.
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
 * capability token. Mirrors the placeholder id used by the native messaging
 * helper at `clients/chrome-extension-native-host/src/index.ts`
 * (`ALLOWED_EXTENSION_IDS`) and the macOS installer at
 * `clients/macos/vellum-assistant/App/AppDelegate+NativeMessaging.swift`
 * (`devPlaceholderId`). All three must agree for the dev pair flow to work
 * end-to-end — the
 * `assistant/src/__tests__/extension-id-sync-guard.test.ts` sync guard
 * will fail if any of the three drifts out of sync, so update them
 * together before release.
 */
export const ALLOWED_EXTENSION_ORIGINS: ReadonlySet<string> = new Set<string>([
  // Dev placeholder — replaced when the unpacked extension is loaded locally.
  // SYNC: update alongside the native host and macOS installer constants
  // (see extension-id-sync-guard.test.ts). TODO: production chrome extension
  // id before release.
  "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
]);

/**
 * Parse an HTTP `Host` header value and extract the hostname portion.
 *
 * Handles IPv6 bracket notation (`[::1]:8765`), unbracketed IPv6
 * (`::1`), hostname with port (`localhost:8765`), and bare hostnames
 * (`localhost`). Returns `null` when the header is malformed (e.g.
 * missing closing bracket, or content after the closing bracket that
 * isn't an optional `:port`).
 *
 * Exported for testing.
 */
export function parseHostHeader(raw: string): string | null {
  if (raw.length === 0) return null;
  // IPv6 literal in brackets, e.g. `[::1]` or `[::1]:8765`.
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end < 0) return null;
    // After the closing bracket only an optional ":port" is valid. Anything
    // else (e.g. `[::1]attacker.com`) is a malformed Host header that an
    // attacker could craft to slip a non-loopback hostname past the parser.
    const after = raw.substring(end + 1);
    if (after.length > 0 && !after.startsWith(":")) return null;
    return raw.substring(1, end);
  }
  // Bare IPv6 (no brackets) contains multiple colons and should be
  // treated as a whole. Anything with a single colon is `host:port`.
  const firstColon = raw.indexOf(":");
  if (firstColon < 0) return raw;
  const secondColon = raw.indexOf(":", firstColon + 1);
  if (secondColon >= 0) {
    // Multiple colons and no brackets — assume unbracketed IPv6.
    return raw;
  }
  return raw.substring(0, firstColon);
}

/**
 * Returns true if the Host header (if present) points at a loopback
 * address. We accept a missing Host header because some HTTP clients
 * (notably node test harnesses) omit it.
 */
function isLoopbackHostHeader(host: string | null): boolean {
  if (!host) return true;
  const parsed = parseHostHeader(host);
  if (parsed === null) return false;
  const hostname = parsed.toLowerCase();
  if (hostname === "localhost") return true;
  if (hostname === "127.0.0.1") return true;
  if (hostname === "::1") return true;
  if (hostname.startsWith("127.")) {
    // Matches the 127.0.0.0/8 loopback range (e.g. 127.0.0.1, 127.1.2.3).
    const parts = hostname.split(".");
    if (parts.length !== 4) return false;
    return parts.every((p) => /^\d+$/.test(p) && Number(p) <= 255);
  }
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
 * Body:    `{ extensionOrigin: string }` (also accepts legacy
 *          `{ origin: string }` for backwards compatibility).
 * Returns: `{ token, expiresAt, guardianId }` where `expiresAt` is an
 *          ISO 8601 timestamp string that the native messaging helper
 *          validates as a string.
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

  // Accept `extensionOrigin` (preferred, matches the native messaging
  // helper) and fall back to `origin` (legacy, for any callers that
  // haven't migrated yet).
  const raw = body as {
    extensionOrigin?: unknown;
    origin?: unknown;
  };
  const extensionOrigin =
    typeof raw.extensionOrigin === "string" && raw.extensionOrigin.length > 0
      ? raw.extensionOrigin
      : typeof raw.origin === "string" && raw.origin.length > 0
        ? raw.origin
        : null;
  if (extensionOrigin === null) {
    return httpError("BAD_REQUEST", "extensionOrigin is required", 400);
  }

  if (!ALLOWED_EXTENSION_ORIGINS.has(extensionOrigin)) {
    log.warn(
      { extensionOrigin },
      "Rejecting browser-extension-pair for disallowed origin",
    );
    return httpError("UNAUTHORIZED", "unauthorized origin", 401);
  }

  const guardianId = resolveLocalGuardianId();
  const { token, expiresAt } = mintHostBrowserCapability(guardianId);
  const expiresAtIso = new Date(expiresAt).toISOString();

  log.info(
    { extensionOrigin, guardianId, expiresAt: expiresAtIso },
    "Issued chrome extension capability token",
  );

  return Response.json({ token, expiresAt: expiresAtIso, guardianId });
}
