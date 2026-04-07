/**
 * Capability token minting and verification for scoped, short-lived tokens
 * issued to the chrome extension (and other thin clients) so they can submit
 * results back to the runtime without a full guardian-bound JWT.
 *
 * Design:
 *   - Tokens are HMAC-SHA256 signed over a JSON claims payload.
 *   - Claims include a bound capability, guardian id, nonce, and expiry.
 *   - Signing uses a long-lived random secret persisted to the workspace
 *     data dir with 0600 permissions (mirrors `token-service.ts` pattern).
 *   - The secret is generated once on first launch and reused across
 *     subsequent daemon restarts so previously-minted tokens still verify.
 *   - Tests inject their own secret via `setCapabilityTokenSecretForTests`.
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
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getDataDir } from "../util/platform.js";

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

/**
 * Returns the path where the capability-token secret is persisted.
 * Lives alongside other runtime-generated keys under workspace/data.
 */
function getSecretPath(): string {
  return join(getDataDir(), "capability-token-secret");
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
  const dir = dirname(keyPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${keyPath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, fresh, { mode: 0o600 });
  renameSync(tmpPath, keyPath);
  try {
    chmodSync(keyPath, 0o600);
  } catch (err) {
    log.warn(
      { err, keyPath },
      "Failed to chmod capability token secret after write",
    );
  }
  log.info("Capability token secret generated and persisted");
  return fresh;
}

/**
 * Initialize the module-level secret. Called once at daemon startup. Safe
 * to call multiple times — subsequent calls overwrite the cached value
 * (useful in tests that reset state).
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
 * Reset the cached secret. Test-only — exposed so test isolation can
 * force a reload from disk.
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
  // Lazy load — daemon startup is expected to call
  // `initCapabilityTokenSecret(loadOrCreateCapabilityTokenSecret())` but
  // we fall back to a disk load here so unit tests and early call sites
  // don't have to depend on startup ordering.
  _secret = loadOrCreateCapabilityTokenSecret();
  return _secret;
}

// ---------------------------------------------------------------------------
// Mint / verify
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

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
  ttlMs: number = DEFAULT_TTL_MS,
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
 * Verify a capability token. Returns the decoded claims on success or null
 * if the signature is invalid, the payload is malformed, the token has
 * expired, or the bound capability is not `host_browser_command`.
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

// ---------------------------------------------------------------------------
// Dev-only fallback token file
// ---------------------------------------------------------------------------

/**
 * Path to the dev-pairing fallback token file. The runtime writes a freshly
 * minted capability token to this location on daemon startup so developers
 * can manually pair the chrome extension without wiring the native
 * messaging helper. Production users should pair via the native helper
 * (PRs 7/12/13).
 */
export function getDaemonTokenFilePath(): string {
  // Always under `~/.vellum/` (not the configurable workspace dir) so the
  // native messaging helper can find it at a fixed path regardless of
  // workspace overrides. This is a dev-only convenience path — production
  // pairing goes through the native messaging flow.
  return join(homedir(), ".vellum", "daemon-token");
}

/**
 * Write a freshly-minted capability token to `~/.vellum/daemon-token` with
 * 0600 permissions. Swallows errors so a failure here never blocks daemon
 * startup — this is a dev-convenience path, not a production auth
 * requirement.
 */
export function writeDaemonTokenFallback(guardianId: string): void {
  try {
    const { token } = mintHostBrowserCapability(guardianId);
    const filePath = getDaemonTokenFilePath();
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    writeFileSync(tmpPath, token, { mode: 0o600 });
    renameSync(tmpPath, filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // best-effort
    }
    log.info({ filePath }, "Dev capability token written to daemon-token file");
  } catch (err) {
    log.warn(
      { err },
      "Failed to write dev capability token file; manual pairing still available via /v1/browser-extension-pair",
    );
  }
}
