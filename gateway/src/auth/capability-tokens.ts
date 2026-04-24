/**
 * Capability token minting and verification for scoped, short-lived tokens
 * issued to the chrome extension (and other thin clients) so they can submit
 * results back to the runtime without a full guardian-bound JWT.
 *
 * Design:
 *   - Tokens are HMAC-SHA256 signed over a JSON claims payload.
 *   - Claims include a bound capability, guardian id, nonce, and expiry.
 *   - Signing uses a long-lived random secret persisted to
 *     GATEWAY_SECURITY_DIR with 0600 permissions.
 *   - The secret is generated once on first launch and reused across
 *     subsequent restarts so previously-minted tokens still verify.
 *
 * The encoded token format is `<base64url(payload)>.<base64url(sig)>`.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getLogger } from "../logger.js";
import { getGatewaySecurityDir } from "../paths.js";

const log = getLogger("capability-tokens");

// ---------------------------------------------------------------------------
// Types
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
// Secret lifecycle
// ---------------------------------------------------------------------------

let _secret: Buffer | undefined;

const CAPABILITY_TOKEN_SECRET_FILENAME = "capability-token-secret";

function getSecretPath(): string {
  return join(getGatewaySecurityDir(), CAPABILITY_TOKEN_SECRET_FILENAME);
}

/**
 * Write `secret` to `keyPath` atomically with mode 0o600.
 */
function writeSecretAtomic(keyPath: string, secret: Buffer): void {
  const dir = dirname(keyPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${keyPath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, secret, { mode: 0o600 });
  renameSync(tmpPath, keyPath);
  try {
    chmodSync(keyPath, 0o600);
  } catch (err) {
    log.warn(
      { err, keyPath },
      "Failed to chmod capability token secret after write",
    );
  }
}

/**
 * Load the capability-token secret from disk or generate and persist a new
 * one. Atomically writes with mode 0o600 so the secret is not readable by
 * other users on the same host.
 */
export function loadOrCreateCapabilityTokenSecret(): Buffer {
  const keyPath = getSecretPath();
  if (existsSync(keyPath)) {
    try {
      const raw = readFileSync(keyPath);
      if (raw.length === 32) {
        return raw;
      }
      log.warn(
        { keyPath, length: raw.length },
        "capability token secret has unexpected length — regenerating",
      );
    } catch (err) {
      log.warn(
        { err, keyPath },
        "Failed to read capability token secret — regenerating",
      );
    }
  }

  const fresh = randomBytes(32);
  writeSecretAtomic(keyPath, fresh);
  log.info("Capability token secret generated and persisted");
  return fresh;
}

/**
 * Initialize the module-level secret. Called once at gateway startup.
 */
export function initCapabilityTokenSecret(secret: Buffer): void {
  if (secret.length !== 32) {
    throw new Error(
      `capability token secret must be 32 bytes, got ${secret.length}`,
    );
  }
  _secret = secret;
}

/**
 * Test-only helper to inject a deterministic secret.
 */
export function setCapabilityTokenSecretForTests(secret: Buffer): void {
  _secret = secret;
}

/**
 * Reset the cached secret. Test-only.
 */
export function resetCapabilityTokenSecretForTests(): void {
  _secret = undefined;
}

function getSecret(): Buffer {
  if (_secret) return _secret;
  if (process.env.NODE_ENV === "test") {
    _secret = randomBytes(32);
    return _secret;
  }
  _secret = loadOrCreateCapabilityTokenSecret();
  return _secret;
}

// ---------------------------------------------------------------------------
// Mint / verify
// ---------------------------------------------------------------------------

const CAPABILITY_TOKEN_DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

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

/**
 * Mint a capability token bound to the `host_browser_command` capability
 * for the given guardian id. Default TTL is 30 minutes.
 */
export function mintHostBrowserCapability(
  guardianId: string,
  ttlMs: number = CAPABILITY_TOKEN_DEFAULT_TTL_MS,
): CapabilityToken {
  const expiresAt = Date.now() + ttlMs;
  const nonce = randomBytes(16).toString("hex");
  const claims: CapabilityClaims = {
    capability: "host_browser_command",
    guardianId,
    nonce,
    expiresAt,
  };
  const payload = base64urlEncode(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = sign(payload, getSecret());
  return { token: `${payload}.${sig}`, expiresAt };
}

/**
 * Verify a capability token minted by `mintHostBrowserCapability`.
 *
 * Returns the decoded claims on success or null if the signature is
 * invalid, the payload is malformed, the token has expired, or the bound
 * capability is not `host_browser_command`.
 *
 * Signature comparison uses `timingSafeEqual` to avoid leaking the secret
 * through timing side channels.
 */
export function verifyHostBrowserCapability(
  token: string,
): CapabilityClaims | null {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!payload || !sig) return null;

  const expected = sign(payload, getSecret());
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
  if (typeof claims.nonce !== "string" || claims.nonce.length === 0) {
    return null;
  }
  if (typeof claims.expiresAt !== "number" || claims.expiresAt <= Date.now()) {
    return null;
  }
  return claims;
}
