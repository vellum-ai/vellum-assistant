/**
 * Token acquisition for Google service-account credentials (Vertex AI).
 *
 * Reads the service-account JSON from the vault, signs a short-lived JWT
 * with RS256, and exchanges it for a bearer access token at the token_uri
 * embedded in the key file. Caches the resulting token and its expiry as a
 * single JSON blob in the vault so the write is treated as one unit.
 *
 * A per-credential mutex prevents concurrent callers for the same credential
 * from racing to refresh. Callers for different credentials are independent.
 */

import { createSign } from "node:crypto";

import {
  getSecureKeyAsync as _realGetKey,
  setSecureKeyAsync as _realSetKey,
} from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";

// Mutable references — swapped in tests via _injectVaultAccessors so tests
// never need mock.module (which contaminates the entire bun worker process).
let _getKey: typeof _realGetKey = _realGetKey;
let _setKey: typeof _realSetKey = _realSetKey;

const log = getLogger("service-account-token");

/** Refresh 5 minutes before expiry to avoid using a nearly-expired token. */
const REFRESH_MARGIN_SECONDS = 300;

/** Google Cloud Platform scope required for Vertex AI inference. */
const GCP_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

export type ServiceAccountTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: "not_found" | "invalid_config" | "exchange_failed" };

/**
 * Parse and validate a service-account JSON string.
 * Returns the key object when valid, or null when the JSON is missing, invalid,
 * or lacks required fields (client_email, private_key, token_uri).
 */
export function parseServiceAccountKey(json: string): ServiceAccountKey | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const key = parsed as Record<string, unknown>;
  if (
    typeof key["client_email"] !== "string" ||
    !key["client_email"] ||
    typeof key["private_key"] !== "string" ||
    !key["private_key"] ||
    typeof key["token_uri"] !== "string" ||
    !key["token_uri"]
  ) {
    return null;
  }
  // All required fields validated as non-empty strings above.
  return parsed as ServiceAccountKey;
}

/** Per-credential in-flight mutex. Prevents concurrent exchange races per account. */
const exchangesInFlight = new Map<string, Promise<ServiceAccountTokenResult>>();

/**
 * Return a valid bearer access token for a Google service account, fetching
 * and caching one if the stored token is absent or about to expire.
 *
 * @param credential - Vault key under which the service-account JSON is stored
 *   (e.g. `"credential/my-vertex-ai"`). The derived token is cached as a JSON
 *   blob at `<credential>/token_cache`.
 */
export async function getValidServiceAccountToken(
  credential: string,
): Promise<ServiceAccountTokenResult> {
  const cacheKey = `${credential}/token_cache`;
  const cached = await _getKey(cacheKey);
  if (cached) {
    try {
      const blob = JSON.parse(cached) as {
        access_token?: string;
        expires_at?: number;
      };
      if (blob.access_token) {
        if (!blob.expires_at) {
          return { ok: true, token: blob.access_token };
        }
        const now = Date.now() / 1000;
        if (now < blob.expires_at - REFRESH_MARGIN_SECONDS) {
          return { ok: true, token: blob.access_token };
        }
      }
    } catch {
      // Corrupted cache entry — fall through to re-exchange.
    }
  }

  const inFlight = exchangesInFlight.get(credential);
  if (inFlight) {
    return await inFlight;
  }

  const promise = doExchange(credential, cacheKey);
  exchangesInFlight.set(credential, promise);
  try {
    return await promise;
  } finally {
    exchangesInFlight.delete(credential);
  }
}

async function doExchange(
  credential: string,
  cacheKey: string,
): Promise<ServiceAccountTokenResult> {
  const keyJson = await _getKey(credential);
  if (!keyJson) {
    return { ok: false, reason: "not_found" };
  }

  const key = parseServiceAccountKey(keyJson);
  if (!key) {
    log.error(
      { credential },
      "Service account credential is not valid JSON or missing required fields",
    );
    return { ok: false, reason: "invalid_config" };
  }

  const jwt = buildJwt(key.client_email, key.private_key, key.token_uri);

  let accessToken: string;
  let expiresIn: number;
  try {
    const resp = await fetch(key.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }).toString(),
    });

    if (!resp.ok) {
      const body = await resp.text();
      log.error(
        { status: resp.status, body, credential },
        "Service account token exchange failed",
      );
      return { ok: false, reason: "exchange_failed" };
    }

    const data = (await resp.json()) as {
      access_token?: string;
      expires_in?: number;
    };

    if (!data.access_token) {
      log.error({ credential }, "Token exchange response missing access_token");
      return { ok: false, reason: "exchange_failed" };
    }

    accessToken = data.access_token;
    expiresIn = data.expires_in ?? 3600;
  } catch (err) {
    log.error({ err, credential }, "Service account token exchange threw");
    return { ok: false, reason: "exchange_failed" };
  }

  const newExpiresAt = Math.floor(Date.now() / 1000 + expiresIn);
  const ok = await _setKey(
    cacheKey,
    JSON.stringify({ access_token: accessToken, expires_at: newExpiresAt }),
  );
  if (!ok) {
    log.warn(
      { credential },
      "Failed to cache service account token — token still valid for this request",
    );
  } else {
    log.info({ credential }, "Service account token exchanged and cached");
  }
  return { ok: true, token: accessToken };
}

function buildJwt(
  clientEmail: string,
  privateKey: string,
  tokenUri: string,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: clientEmail,
      scope: GCP_SCOPE,
      aud: tokenUri,
      exp: now + 3600,
      iat: now,
    }),
  ).toString("base64url");

  const signingInput = `${header}.${payload}`;
  const sign = createSign("SHA256");
  sign.update(signingInput);
  sign.end();
  const signature = sign.sign(privateKey, "base64url");

  return `${signingInput}.${signature}`;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** @internal Test-only: reset all in-flight exchange mutexes. */
export function _resetServiceAccountMutex(): void {
  exchangesInFlight.clear();
}

/** @internal Test-only: swap vault accessors so tests never need mock.module. */
export function _injectVaultAccessors(
  get: typeof _realGetKey,
  set: typeof _realSetKey,
): void {
  _getKey = get;
  _setKey = set;
}

/** @internal Test-only: restore real vault accessors. */
export function _resetVaultAccessors(): void {
  _getKey = _realGetKey;
  _setKey = _realSetKey;
}
