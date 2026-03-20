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
import { dirname, join } from "node:path";

import { getLogger } from "../../util/logger.js";
import { getRootDir } from "../../util/platform.js";
import { CURRENT_POLICY_EPOCH, isStaleEpoch } from "./policy.js";
import type { ScopeProfile, TokenAudience, TokenClaims } from "./types.js";

const log = getLogger("token-service");

// ---------------------------------------------------------------------------
// Bootstrap sentinel error
// ---------------------------------------------------------------------------

/**
 * Thrown when the gateway's signing-key bootstrap endpoint returns 403,
 * indicating that bootstrap has already completed (daemon restart case).
 * The caller should fall back to loading the key from disk.
 */
export class BootstrapAlreadyCompleted extends Error {
  constructor() {
    super("Gateway signing key bootstrap already completed");
    this.name = "BootstrapAlreadyCompleted";
  }
}

// ---------------------------------------------------------------------------
// Signing key management
// ---------------------------------------------------------------------------

let _authSigningKey: Buffer | undefined;

/**
 * Path to the persisted signing key file.
 * Stored in the protected directory alongside other sensitive material.
 */
function getSigningKeyPath(): string {
  return join(getRootDir(), "protected", "actor-token-signing-key");
}

/**
 * Load a signing key from disk or generate and persist a new one.
 * Uses atomic-write + chmod 0o600 for safe persistence.
 */
export function loadOrCreateSigningKey(): Buffer {
  const keyPath = getSigningKeyPath();

  // Try to load existing key
  if (existsSync(keyPath)) {
    try {
      const raw = readFileSync(keyPath);
      if (raw.length === 32) {
        log.info("Auth signing key loaded from disk");
        return raw;
      }
      log.warn("Signing key file has unexpected length, regenerating");
    } catch (err) {
      log.warn({ err }, "Failed to read signing key file, regenerating");
    }
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
 * Fetch the shared signing key from the gateway's bootstrap endpoint.
 *
 * Used in Docker mode where the gateway owns the signing key and the daemon
 * must fetch it at startup. Retries up to 30 times with 1s intervals to
 * tolerate gateway startup delays.
 *
 * @returns A 32-byte Buffer containing the signing key.
 * @throws {BootstrapAlreadyCompleted} If the gateway returns 403 (bootstrap
 *   already completed — daemon restart case). Caller should fall back to
 *   loading the key from disk.
 * @throws {Error} If the gateway is unreachable after all retry attempts.
 */
export async function fetchSigningKeyFromGateway(): Promise<Buffer> {
  const gatewayUrl = process.env.GATEWAY_INTERNAL_URL;
  if (!gatewayUrl) {
    throw new Error("GATEWAY_INTERNAL_URL not set — cannot fetch signing key");
  }

  const maxAttempts = 30;
  const intervalMs = 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let resp: Response | undefined;
    try {
      resp = await fetch(`${gatewayUrl}/internal/signing-key-bootstrap`, {
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      log.warn(
        { err, attempt },
        "Signing key bootstrap: connection failed, retrying",
      );
      await Bun.sleep(intervalMs);
      continue;
    }

    if (resp.ok) {
      const body = (await resp.json()) as { key: string };
      const keyBuf = Buffer.from(body.key, "hex");
      if (keyBuf.length !== 32) {
        throw new Error(`Invalid signing key length: ${keyBuf.length}`);
      }
      log.info("Signing key fetched from gateway bootstrap endpoint");
      return keyBuf;
    }

    if (resp.status === 403) {
      // Bootstrap already completed — fall through to file-based load.
      // This happens on daemon restart when the gateway lockfile persists.
      log.info(
        "Gateway signing key bootstrap already completed — loading from disk",
      );
      throw new BootstrapAlreadyCompleted();
    }

    log.warn(
      { status: resp.status, attempt },
      "Signing key bootstrap: gateway not ready, retrying",
    );

    await Bun.sleep(intervalMs);
  }

  throw new Error("Signing key bootstrap: timed out waiting for gateway");
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
 * Returns a short hex fingerprint of the current signing key.
 * Used by daemon_status to let clients detect instance switches.
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
