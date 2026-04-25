/**
 * Capability token verification for scoped, short-lived tokens issued to the
 * chrome extension (and other thin clients).
 *
 * Both minting and verification are owned by the gateway
 * (`gateway/src/auth/capability-tokens.ts`). The daemon delegates
 * verification to the gateway via IPC so it never needs to read the
 * HMAC secret from the filesystem.
 *
 * Test-only helpers (`mintHostBrowserCapability`,
 * `setCapabilityTokenSecretForTests`, `resetCapabilityTokenSecretForTests`)
 * implement the same HMAC logic in-process so assistant tests can create
 * and verify tokens without a live gateway.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { ipcCall } from "../ipc/gateway-client.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("capability-tokens");

// ---------------------------------------------------------------------------
// Types (mirror the gateway's types for consumer convenience)
// ---------------------------------------------------------------------------

/** Capability identifiers that can be bound to a capability token. */
export type Capability = "host_browser_command";

/** Claims encoded in the signed payload. */
export interface CapabilityClaims {
  capability: Capability;
  guardianId: string;
  /** 16-byte random nonce, hex-encoded. Prevents replay across fresh mints. */
  nonce: string;
  /** ms-since-epoch expiry. */
  expiresAt: number;
}

/** A freshly-minted capability token and its absolute expiry. */
export interface CapabilityToken {
  token: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// In-process HMAC helpers (shared between test mint/verify and IPC verify)
// ---------------------------------------------------------------------------

let _testSecret: Buffer | undefined;

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  return Buffer.from(b64, "base64");
}

function sign(payload: string, secret: Buffer): string {
  return base64urlEncode(createHmac("sha256", secret).update(payload).digest());
}

// ---------------------------------------------------------------------------
// Verify (production: gateway IPC, test: in-process)
// ---------------------------------------------------------------------------

/**
 * Verify a capability token.
 *
 * In production, delegates to the gateway via IPC. In tests (when a
 * secret has been injected via `setCapabilityTokenSecretForTests`),
 * verifies in-process so tests don't need a live gateway.
 *
 * Returns the decoded claims on success or null on any failure.
 */
export async function verifyHostBrowserCapability(
  token: string,
): Promise<CapabilityClaims | null> {
  if (typeof token !== "string" || token.length === 0) return null;

  // Test path: in-process verification with the injected secret.
  if (_testSecret) {
    return verifyInProcess(token, _testSecret);
  }

  // Production path: delegate to the gateway.
  try {
    const result = await ipcCall("verify_capability_token", { token });
    if (!result || typeof result !== "object") return null;

    const claims = result as Record<string, unknown>;
    if (claims.valid === false) return null;
    if (claims.capability !== "host_browser_command") return null;
    if (
      typeof claims.guardianId !== "string" ||
      claims.guardianId.length === 0
    ) {
      return null;
    }

    return claims as unknown as CapabilityClaims;
  } catch (err) {
    log.warn({ err }, "Failed to verify capability token via gateway IPC");
    return null;
  }
}

function verifyInProcess(
  token: string,
  secret: Buffer,
): CapabilityClaims | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!payload || !sig) return null;

  const expected = sign(payload, secret);
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  let claims: CapabilityClaims;
  try {
    claims = JSON.parse(
      base64urlDecode(payload).toString("utf8"),
    ) as CapabilityClaims;
  } catch {
    return null;
  }

  if (!claims || typeof claims !== "object") return null;
  if (claims.capability !== "host_browser_command") return null;
  if (typeof claims.guardianId !== "string" || claims.guardianId.length === 0) {
    return null;
  }
  if (typeof claims.expiresAt !== "number" || claims.expiresAt <= Date.now()) {
    return null;
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/**
 * Mint a capability token in-process. Test-only — production minting is
 * done by the gateway.
 */
export function mintHostBrowserCapability(
  guardianId: string,
  ttlMs: number = 30 * 60 * 1000,
): CapabilityToken {
  const secret = _testSecret;
  if (!secret) {
    throw new Error(
      "capability token secret not set — call setCapabilityTokenSecretForTests() first",
    );
  }
  const expiresAt = Date.now() + ttlMs;
  const nonce = randomBytes(16).toString("hex");
  const claims: CapabilityClaims = {
    capability: "host_browser_command",
    guardianId,
    nonce,
    expiresAt,
  };
  const payload = base64urlEncode(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = sign(payload, secret);
  return { token: `${payload}.${sig}`, expiresAt };
}

/** Inject a deterministic secret for tests. */
export function setCapabilityTokenSecretForTests(secret: Buffer): void {
  _testSecret = secret;
}

/** Reset the test secret. */
export function resetCapabilityTokenSecretForTests(): void {
  _testSecret = undefined;
}
