/**
 * JWT token service for the gateway's auth system.
 *
 * Mirrors the assistant's token-service but manages its own signing key
 * using the same loadOrCreateSigningKey pattern. The key is stored at
 * {getGatewaySecurityDir()}/actor-token-signing-key.
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

import { isStaleEpoch } from "./policy.js";
import type { ScopeProfile, TokenAudience, TokenClaims } from "./types.js";

const log = getLogger("auth-token-service");

// ---------------------------------------------------------------------------
// Signing key management
// ---------------------------------------------------------------------------

let signingKey: Buffer | null = null;

export function getSigningKeyPath(): string {
  return join(getGatewaySecurityDir(), "actor-token-signing-key");
}

/**
 * Resolve the signing key for the gateway.
 *
 * Resolution order:
 *   1. ACTOR_TOKEN_SIGNING_KEY env var (hex-encoded, set by CLI for Docker)
 *   2. Load from disk (GATEWAY_SECURITY_DIR/actor-token-signing-key)
 *   3. Generate a new key and persist to disk (local mode)
 */
export function loadOrCreateSigningKey(): Buffer {
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

  const keyPath = getSigningKeyPath();

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
 * Initialize (or reinitialize) the signing key. Called at gateway startup.
 */
export function initSigningKey(key: Buffer): void {
  signingKey = key;
}

function getSigningKey(): Buffer {
  if (!signingKey) {
    throw new Error(
      "Auth signing key not initialized — call initSigningKey() during startup",
    );
  }
  return signingKey;
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
// JWT header
// ---------------------------------------------------------------------------

const JWT_HEADER = base64urlEncode(
  JSON.stringify({ alg: "HS256", typ: "JWT" }),
);

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

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

export function verifyToken(
  token: string,
  expectedAud: TokenAudience,
  opts?: { allowExpired?: boolean },
): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return {
      ok: false,
      reason: "malformed_token: expected 3 dot-separated parts",
    };
  }

  const [headerPart, payloadPart, sigPart] = parts;

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

  let claims: TokenClaims;
  try {
    const decoded = base64urlDecode(payloadPart).toString("utf-8");
    claims = JSON.parse(decoded) as TokenClaims;
  } catch {
    return { ok: false, reason: "malformed_claims" };
  }

  if (claims.aud !== expectedAud) {
    return {
      ok: false,
      reason: `audience_mismatch: expected ${expectedAud}, got ${claims.aud}`,
    };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!opts?.allowExpired && claims.exp <= nowSeconds) {
    return { ok: false, reason: "token_expired" };
  }

  if (isStaleEpoch(claims.policy_epoch)) {
    return { ok: false, reason: "stale_policy_epoch" };
  }

  return { ok: true, claims };
}
