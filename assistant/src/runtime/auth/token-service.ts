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

import { getLogger } from "../../util/logger.js";
import { getDeprecatedDir } from "../../util/platform.js";
import { CURRENT_POLICY_EPOCH, isStaleEpoch } from "./policy.js";
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
    log.info("Signing key loaded from ACTOR_TOKEN_SIGNING_KEY env var");
    return Buffer.from(envKey, "hex");
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
 * Check whether the auth signing key has been initialized.
 *
 * Useful for out-of-process contexts (CLI) that may run without
 * daemon startup, where callers need to decide whether they can
 * mint JWTs or must fall back to the legacy shared-secret token.
 */
export function isSigningKeyInitialized(): boolean {
  return _authSigningKey !== undefined;
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
// Daemon delivery token
// ---------------------------------------------------------------------------

/**
 * Mint a short-lived JWT for daemon-to-gateway delivery callbacks.
 *
 * Used when the daemon needs to call gateway /deliver/* endpoints. The
 * gateway's deliver-auth middleware validates aud=vellum-daemon, so both
 * sides share the same signing key and audience convention.
 *
 * sub=svc:daemon:self, scope_profile=gateway_service_v1
 */
export function mintDaemonDeliveryToken(): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: "svc:daemon:self",
    scope_profile: "gateway_service_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 60,
  });
}

// ---------------------------------------------------------------------------
// Edge relay token
// ---------------------------------------------------------------------------

/**
 * Mint a short-lived JWT for relay WebSocket connections through the gateway.
 *
 * The gateway's relay WS handler validates tokens with validateEdgeToken(),
 * which expects aud=vellum-gateway. This is distinct from daemon delivery
 * tokens (aud=vellum-daemon) used for gateway /deliver/* endpoints.
 *
 * sub=svc:daemon:self, scope_profile=gateway_service_v1
 */
export function mintEdgeRelayToken(): string {
  return mintToken({
    aud: "vellum-gateway",
    sub: "svc:daemon:self",
    scope_profile: "gateway_service_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 60,
  });
}

// ---------------------------------------------------------------------------
// UI page token
// ---------------------------------------------------------------------------

/**
 * Mint a long-lived JWT for embedding in browser-served UI pages
 * (brain-graph).
 *
 * These pages make API calls that route through the gateway, which validates
 * tokens with validateEdgeToken() expecting aud=vellum-gateway. A 1-hour TTL
 * gives users enough time to interact with the page (including using Refresh
 * buttons) without the token expiring mid-session.
 *
 * Uses the dedicated ui_page_v1 scope profile which grants only settings.read
 * — the minimum needed for the brain-graph data endpoint those pages call.
 */
export function mintUiPageToken(): string {
  return mintToken({
    aud: "vellum-gateway",
    sub: "svc:daemon:self",
    scope_profile: "ui_page_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 3600,
  });
}

// ---------------------------------------------------------------------------
// Pairing bearer token
// ---------------------------------------------------------------------------

/**
 * Mint a JWT bearer token for the iOS pairing flow.
 *
 * Minted once at daemon startup and reused for all pairing approvals
 * during this daemon's lifetime. The token is stored on approved pairing
 * entries and returned in HTTP responses as a legacy compatibility field.
 * (iOS clients also receive proper JWT credentials via mintCredentialPair.)
 *
 * The 24-hour TTL covers a typical daemon lifecycle. The daemon re-mints
 * on each restart since the signing key is stable across restarts.
 *
 * aud=vellum-daemon, sub=svc:daemon:pairing, scope_profile=gateway_service_v1
 */
export function mintPairingBearerToken(): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: "svc:daemon:pairing",
    scope_profile: "gateway_service_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 86400, // 24 hours — covers a typical daemon lifecycle
  });
}

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of a raw token string (for revocation store lookups). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
