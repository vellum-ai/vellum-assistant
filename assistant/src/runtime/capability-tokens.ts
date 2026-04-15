/**
 * Capability token minting and verification for scoped, short-lived tokens
 * issued to the chrome extension (and other thin clients) so they can submit
 * results back to the runtime without a full guardian-bound JWT.
 *
 * Design:
 *   - Tokens are HMAC-SHA256 signed over a JSON claims payload.
 *   - Claims include a bound capability, guardian id, nonce, and expiry.
 *   - Signing uses a long-lived random secret persisted to
 *     `~/.vellum/protected/` with 0600 permissions. The protected
 *     directory sits outside the workspace per AGENTS.md: workspace
 *     directories must not hold security-sensitive material.
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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getDataDir, getProtectedDir } from "../util/platform.js";

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
 * Returns the canonical path where the capability-token secret is
 * persisted: `~/.vellum/protected/capability-token-secret`. The protected
 * directory is the canonical location for security-sensitive material
 * and sits outside the workspace (which AGENTS.md forbids for secrets).
 */
function getSecretPath(): string {
  return join(getProtectedDir(), "capability-token-secret");
}

/**
 * Legacy path under `workspace/data/` where earlier builds persisted the
 * capability-token secret. We keep this as a read-only migration source
 * so existing deployments don't regenerate their secret (and invalidate
 * every outstanding token) on upgrade — the first launch after the
 * upgrade copies the legacy file into `getProtectedDir()` and removes it
 * from the workspace.
 */
function getLegacySecretPath(): string {
  return join(getDataDir(), "capability-token-secret");
}

/**
 * Path overrides used by unit tests to drive the secret lifecycle
 * without touching the real `~/.vellum/` tree. Production callers must
 * omit this argument so the canonical paths (`getProtectedDir()` +
 * `getDataDir()`) are used.
 */
export interface CapabilityTokenSecretPaths {
  /** Protected-directory secret path (authoritative). */
  secretPath: string;
  /** Legacy workspace-directory secret path (migration source). */
  legacySecretPath: string;
}

/**
 * Load the capability-token secret from disk or generate and persist a new
 * one. Atomically writes with mode 0o600 so the secret is not readable by
 * other users on the same host.
 *
 * Migration: if the secret exists only at the legacy workspace path, copy
 * it into the protected directory and delete the workspace copy so we do
 * not leave security-sensitive material inside `workspace/`.
 *
 * The optional `paths` argument is for unit tests only — production
 * callers must omit it and use the canonical `~/.vellum/protected/` /
 * `~/.vellum/workspace/data/` paths.
 */
export function loadOrCreateCapabilityTokenSecret(
  paths?: CapabilityTokenSecretPaths,
): Buffer {
  const keyPath = paths?.secretPath ?? getSecretPath();
  const legacyPath = paths?.legacySecretPath ?? getLegacySecretPath();
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

  // Attempt to migrate a legacy workspace-directory secret before we
  // generate a fresh one. If this succeeds we end up with the legacy
  // secret persisted at the protected path and the workspace copy
  // removed, preserving every outstanding token across the upgrade.
  const migrated = migrateLegacyCapabilityTokenSecret(keyPath, legacyPath);
  if (migrated) {
    return migrated;
  }

  const fresh = randomBytes(32);
  writeSecretAtomic(keyPath, fresh);
  log.info("Capability token secret generated and persisted");
  return fresh;
}

/**
 * Write `secret` to `keyPath` atomically with mode 0o600. Ensures the
 * parent directory exists.
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
 * If a pre-migration capability token secret exists under the workspace
 * data directory, copy it into the protected directory and remove the
 * workspace copy. Returns the migrated secret if migration ran
 * successfully, or `undefined` if there was nothing to migrate or the
 * migration failed.
 */
function migrateLegacyCapabilityTokenSecret(
  secretPath: string,
  legacyPath: string,
): Buffer | undefined {
  if (!existsSync(legacyPath)) {
    return undefined;
  }
  try {
    const raw = readFileSync(legacyPath);
    if (raw.length !== 32) {
      log.warn(
        { legacyPath, length: raw.length },
        "legacy capability token secret has unexpected length — ignoring",
      );
      return undefined;
    }
    writeSecretAtomic(secretPath, raw);
    try {
      unlinkSync(legacyPath);
    } catch (err) {
      log.warn(
        { err, legacyPath },
        "Failed to remove legacy workspace capability token secret after migration",
      );
    }
    log.info(
      { from: legacyPath, to: secretPath },
      "Migrated capability token secret out of workspace into protected directory",
    );
    return raw;
  } catch (err) {
    log.warn(
      { err, legacyPath },
      "Failed to migrate legacy capability token secret — regenerating",
    );
    return undefined;
  }
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
 * Verify a capability token minted by `mintHostBrowserCapability`.
 *
 * Returns the decoded claims on success or null if the signature is
 * invalid, the payload is malformed, the token has expired, or the bound
 * capability is not `host_browser_command`.
 *
 * Signature comparison uses `timingSafeEqual` to avoid leaking the secret
 * through timing side channels.
 *
 * The `/v1/browser-relay` WebSocket upgrade handler in `http-server.ts`
 * (`handleBrowserRelayUpgrade`) calls this to authenticate self-hosted
 * chrome extensions on the capability-token branch before falling
 * through to the JWT compatibility path. The `/v1/host-browser-result`
 * POST route may also call it (see that route's auth handling) when a
 * result is posted back with a capability-token bearer instead of a
 * guardian-bound JWT.
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
