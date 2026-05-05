/**
 * JWT token service for the single-header auth system.
 *
 * Mints and verifies standard JWTs (header.payload.signature) using
 * HMAC-SHA256. Owns the signing key lifecycle (load/create/persist).
 */

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
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

import { getIsContainerized } from "../../config/env-registry.js";
import { getLogger } from "../../util/logger.js";
import { getDeprecatedDir } from "../../util/platform.js";
import { isStaleEpoch } from "./policy.js";
import type { ScopeProfile, TokenAudience, TokenClaims } from "./types.js";

const log = getLogger("token-service");

// ---------------------------------------------------------------------------
// Signing key management
// ---------------------------------------------------------------------------

let _authSigningKey: Buffer | undefined;

/**
 * Hardcoded legacy path to the signing key under ~/.vellum/protected/.
 * Used as a read-only fallback so existing assistants keep working after
 * the code update — avoids generating a new key that would break auth
 * with an already-running daemon.
 *
 * This constant can be deleted once we stop calling the gateway directly.
 */
const LEGACY_SIGNING_KEY_PATH = join(
  homedir(),
  ".vellum",
  "protected",
  "actor-token-signing-key",
);

/**
 * Returns the canonical path to the signing key file under workspace/deprecated/.
 *
 * This file can be fully deleted once the assistant stops making direct
 * calls to the gateway (i.e. all auth flows go through the env var).
 */
function getSigningKeyPath(): string {
  return join(getDeprecatedDir(), "actor-token-signing-key");
}

/**
 * Load a signing key from a file on disk. Returns the key buffer if found
 * and valid, or undefined if the file does not exist or is invalid.
 */
export function loadSigningKey(): Buffer | undefined {
  // Try the canonical workspace/deprecated/ path first, then fall back to
  // the legacy protected/ path so existing assistants keep working.
  for (const keyPath of [getSigningKeyPath(), LEGACY_SIGNING_KEY_PATH]) {
    if (!existsSync(keyPath)) {
      continue;
    }
    try {
      const raw = readFileSync(keyPath);
      if (raw.length === 32) {
        log.info({ keyPath }, "Auth signing key loaded from disk");
        return raw;
      }
      log.warn({ keyPath }, "Signing key file has unexpected length");
    } catch (err) {
      log.warn({ err, keyPath }, "Failed to read signing key file");
    }
  }
  return undefined;
}

/**
 * Load a signing key from disk or generate and persist a new one.
 * Uses atomic-write + chmod 0o600 for safe persistence.
 *
 * The key is stored at workspace/deprecated/actor-token-signing-key.
 * This file can be fully deleted once the assistant stops making direct
 * calls to the gateway (i.e. all auth flows go through the env var).
 */
export function loadOrCreateSigningKey(): Buffer {
  const keyPath = getSigningKeyPath();
  const existing = loadSigningKey();
  if (existing) {
    return existing;
  }

  // Generate and persist a new key
  const newKey = randomBytes(32);
  const dir = dirname(keyPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = keyPath + ".tmp." + process.pid;
  writeFileSync(tmpPath, newKey, { mode: 0o600 });
  renameSync(tmpPath, keyPath);
  chmodSync(keyPath, 0o600);

  log.info("Auth signing key generated and persisted");
  return newKey;
}

/**
 * Best-effort sync of the env-resolved signing key to the canonical disk
 * path so out-of-process CLI commands (e.g. browser relay) that load from
 * disk converge on the same key the daemon uses.
 *
 * Security note: this does NOT expand the signing key's exposure surface.
 * `loadOrCreateSigningKey()` already writes a signing key to the exact same
 * disk path (getSigningKeyPath()) with the same mode (0600). A signing key
 * is always on disk for CLI subprocesses to read — this function just
 * ensures the disk key matches the env-provided key so those subprocesses
 * mint tokens the daemon will actually accept.
 *
 * Skipped in containerized mode where disk key files are not used.
 * Uses atomic write (tmp + rename) with mode 0600 for safe persistence.
 * Never throws -- logs a warning on write failure and continues with
 * the in-memory key.
 */
function syncEnvSigningKeyToDiskIfNeeded(key: Buffer): void {
  if (getIsContainerized()) {
    return;
  }

  const keyPath = getSigningKeyPath();

  try {
    // If the file already exists and is byte-equal, no-op.
    if (existsSync(keyPath)) {
      const existing = readFileSync(keyPath);
      if (existing.length === key.length && timingSafeEqual(existing, key)) {
        return;
      }
    }

    // Write atomically: tmp file + rename.
    const dir = dirname(keyPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmpPath = keyPath + ".tmp." + process.pid;
    writeFileSync(tmpPath, key, { mode: 0o600 });
    renameSync(tmpPath, keyPath);
    chmodSync(keyPath, 0o600);

    log.info("Synced env signing key to disk for CLI convergence");
  } catch (err) {
    log.warn(
      { err },
      "Failed to sync env signing key to disk — continuing with in-memory key",
    );
  }
}

/**
 * Resolve the signing key for the daemon from the `ACTOR_TOKEN_SIGNING_KEY`
 * env var (hex-encoded, 64 chars). The CLI launcher sets this before
 * spawning the daemon; in Docker the gateway injects it.
 */
export function resolveSigningKey(): Buffer {
  const envKey = process.env.ACTOR_TOKEN_SIGNING_KEY;
  if (envKey) {
    if (!/^[0-9a-f]{64}$/i.test(envKey)) {
      throw new Error(
        `Invalid ACTOR_TOKEN_SIGNING_KEY: expected 64 hex characters, got ${envKey.length} chars`,
      );
    }
    const key = Buffer.from(envKey, "hex");
    syncEnvSigningKeyToDiskIfNeeded(key);
    log.info("Signing key loaded from ACTOR_TOKEN_SIGNING_KEY env var");
    return key;
  }

  // Fallback: env var not set (e.g. daemon spawned by cli/src/lib/local.ts
  // which does not yet inject the env var). Load or create from disk.
  log.warn("ACTOR_TOKEN_SIGNING_KEY env var not set — falling back to disk");
  return loadOrCreateSigningKey();
}

function getSigningKey(): Buffer {
  if (!_authSigningKey) {
    if (process.env.NODE_ENV === "test") {
      _authSigningKey = randomBytes(32);
      return _authSigningKey;
    }
    throw new Error(
      "Auth signing key not initialized — call initAuthSigningKey() during startup",
    );
  }
  return _authSigningKey;
}

/**
 * Initialize the auth signing key. Called at daemon startup with a key
 * loaded from disk via loadOrCreateSigningKey(), or by tests with a
 * deterministic key.
 */
export function initAuthSigningKey(key: Buffer): void {
  _authSigningKey = key;
}

/**
 * Reset the signing key to undefined. **Test-only** — used to simulate a
 * fresh CLI subprocess where initAuthSigningKey() was never called.
 */
export function _resetSigningKeyForTesting(): void {
  _authSigningKey = undefined;
}

/**
 * Returns a short hex fingerprint of the current signing key.
 * Used by assistant_status to let clients detect instance switches.
 */
export function getSigningKeyFingerprint(): string {
  return createHash("sha256")
    .update(getSigningKey())
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Base64url helpers
// ---------------------------------------------------------------------------

function base64urlEncode(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return buf.toString("base64url");
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type VerifyResult =
  | { ok: true; claims: TokenClaims }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// JWT header — static for HMAC-SHA256
// ---------------------------------------------------------------------------

const JWT_HEADER = base64urlEncode(
  JSON.stringify({ alg: "HS256", typ: "JWT" }),
);

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

/**
 * Mint a new JWT token with the given parameters.
 *
 * Returns the complete JWT string (header.payload.signature).
 */
export function mintToken(params: {
  aud: TokenAudience;
  sub: string;
  scope_profile: ScopeProfile;
  policy_epoch: number;
  ttlSeconds: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: TokenClaims = {
    iss: "vellum-auth",
    aud: params.aud,
    sub: params.sub,
    scope_profile: params.scope_profile,
    exp: now + params.ttlSeconds,
    policy_epoch: params.policy_epoch,
    iat: now,
    jti: randomBytes(16).toString("hex"),
  };

  const payload = base64urlEncode(JSON.stringify(claims));
  const sigInput = JWT_HEADER + "." + payload;
  const sig = createHmac("sha256", getSigningKey()).update(sigInput).digest();

  return sigInput + "." + base64urlEncode(sig);
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verify a JWT token's structural integrity, signature, expiration,
 * audience, and policy epoch.
 *
 * Does NOT check revocation — callers must additionally verify the
 * token hash against a revocation store if needed.
 */
export function verifyToken(
  token: string,
  expectedAud: TokenAudience,
): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return {
      ok: false,
      reason: "malformed_token: expected 3 dot-separated parts",
    };
  }

  const [headerPart, payloadPart, sigPart] = parts;

  // Recompute HMAC over header.payload
  const sigInput = headerPart + "." + payloadPart;
  const expectedSig = createHmac("sha256", getSigningKey())
    .update(sigInput)
    .digest();
  const actualSig = base64urlDecode(sigPart);

  if (expectedSig.length !== actualSig.length) {
    return { ok: false, reason: "invalid_signature" };
  }

  if (!timingSafeEqual(expectedSig, actualSig)) {
    return { ok: false, reason: "invalid_signature" };
  }

  // Decode and parse claims
  let claims: TokenClaims;
  try {
    const decoded = base64urlDecode(payloadPart).toString("utf-8");
    claims = JSON.parse(decoded) as TokenClaims;
  } catch {
    return { ok: false, reason: "malformed_claims" };
  }

  // Audience check
  if (claims.aud !== expectedAud) {
    return {
      ok: false,
      reason: `audience_mismatch: expected ${expectedAud}, got ${claims.aud}`,
    };
  }

  // Expiration check (claims.exp is in seconds)
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (claims.exp <= nowSeconds) {
    return { ok: false, reason: "token_expired" };
  }

  // Policy epoch check
  if (isStaleEpoch(claims.policy_epoch)) {
    return { ok: false, reason: "stale_policy_epoch" };
  }

  return { ok: true, claims };
}

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of a raw token string (for revocation store lookups). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
