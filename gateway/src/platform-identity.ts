/**
 * Bound platform identity (assistant, organization, user).
 *
 * Django maps an assistant API key to these ids via
 * `POST /v1/internal/assistants/validate/`. Resolution reads in-memory
 * overrides (and `PLATFORM_ASSISTANT_ID` / `PLATFORM_ORGANIZATION_ID` /
 * `PLATFORM_USER_ID` when set). When the bound ids are empty, or the
 * API key / platform base URL that produced them has changed, the next
 * resolve retries validate (single-flight, with a cooldown after a failed
 * validate attempt for the same credentials).
 *
 * A credential-store outage is not treated as a missing identity when a
 * prior successful resolve is cached in this process. A credential change
 * that can be read drops the previous ids so the new key is not paired
 * with the old owner.
 */

import type { CredentialCache } from "./credential-cache.js";
import { credentialKey } from "./credential-key.js";
import { readCredentialResult } from "./credential-reader.js";
import { fetchImpl } from "./fetch.js";
import { getLogger } from "./logger.js";

const log = getLogger("platform-identity");

export const PLATFORM_IDENTITY_VALIDATE_PATH =
  "/v1/internal/assistants/validate/";

const VALIDATE_TIMEOUT_MS = 5_000;
const ENSURE_COOLDOWN_MS = 10_000;

const ASSISTANT_API_KEY_ACCOUNT = credentialKey("vellum", "assistant_api_key");
const PLATFORM_BASE_URL_ACCOUNT = credentialKey("vellum", "platform_base_url");

export type PlatformIdentityIds = {
  assistantId: string;
  organizationId: string;
  userId: string;
};

export type StoredPlatformUserId = {
  userId: string | undefined;
  unreachable: boolean;
};

let platformAssistantIdOverride: string | undefined;
let platformOrganizationIdOverride: string | undefined;
let platformUserIdOverride: string | undefined;
let identityBoundToFingerprint: string | undefined;
let lastAttemptFingerprint: string | undefined;
let credentialCache: CredentialCache | undefined;
let ensureInFlight: Promise<void> | null = null;
let nextEnsureAttemptAt = 0;
let lastEnsureUnreachable = false;

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function envTrim(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function getPlatformAssistantId(): string {
  return (
    platformAssistantIdOverride || envTrim("PLATFORM_ASSISTANT_ID")
  ).trim();
}

function getPlatformOrganizationId(): string {
  return (
    platformOrganizationIdOverride || envTrim("PLATFORM_ORGANIZATION_ID")
  ).trim();
}

function getPlatformUserId(): string {
  return (platformUserIdOverride || envTrim("PLATFORM_USER_ID")).trim();
}

function hasBoundIdentity(): boolean {
  return Boolean(getPlatformAssistantId() && getPlatformUserId());
}

function identityFingerprint(apiKey: string, baseUrl: string): string {
  return `${baseUrl}\0${apiKey}`;
}

function clearPlatformIdentityOverrides(): void {
  platformAssistantIdOverride = undefined;
  platformOrganizationIdOverride = undefined;
  platformUserIdOverride = undefined;
}

export function applyPlatformIdentityIds(ids: PlatformIdentityIds): void {
  if (ids.assistantId) {
    platformAssistantIdOverride = ids.assistantId;
  }
  if (ids.organizationId) {
    platformOrganizationIdOverride = ids.organizationId;
  }
  if (ids.userId) {
    platformUserIdOverride = ids.userId;
  }
}

/**
 * Use the gateway credential cache for API key / base URL lookups so a
 * vault outage can still retry validate with last-good secrets.
 */
export function bindPlatformIdentityCredentialCache(
  cache: CredentialCache | undefined,
): void {
  credentialCache = cache;
}

/** @internal Test-only: drop in-memory identity and in-flight ensure state. */
export function _resetPlatformIdentityForTests(): void {
  platformAssistantIdOverride = undefined;
  platformOrganizationIdOverride = undefined;
  platformUserIdOverride = undefined;
  identityBoundToFingerprint = undefined;
  lastAttemptFingerprint = undefined;
  credentialCache = undefined;
  ensureInFlight = null;
  nextEnsureAttemptAt = 0;
  lastEnsureUnreachable = false;
}

/** @internal Alias so existing auth tests can reset the bound owner id. */
export function _resetLastKnownPlatformUserIdForTest(): void {
  _resetPlatformIdentityForTests();
}

/**
 * Trade an assistant API key for the bound platform ids.
 *
 * Returns null when the platform is unreachable, refuses the key, or the
 * body has no ids. Never throws.
 */
export async function fetchPlatformIdentityIds(
  baseUrl: string,
  apiKey: string,
): Promise<PlatformIdentityIds | null> {
  const url = `${baseUrl.replace(/\/+$/, "")}${PLATFORM_IDENTITY_VALIDATE_PATH}`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn(
        { status: res.status },
        "platform identity validate returned non-2xx",
      );
      return null;
    }
    const body: unknown = await res.json();
    if (!body || typeof body !== "object") {
      return null;
    }
    const obj = body as Record<string, unknown>;
    const assistantId = asNonEmptyString(obj.assistant_id);
    const organizationId = asNonEmptyString(obj.organization_id);
    const userId = asNonEmptyString(obj.user_id);
    if (!assistantId && !organizationId && !userId) {
      return null;
    }
    return {
      assistantId: assistantId ?? "",
      organizationId: organizationId ?? "",
      userId: userId ?? "",
    };
  } catch (err) {
    log.warn({ err }, "platform identity validate failed");
    return null;
  }
}

async function readCredentialOrEnv(
  account: string,
  envValue: string,
): Promise<{ value: string; unreachable: boolean }> {
  if (credentialCache) {
    const cached = (await credentialCache.get(account))?.trim() ?? "";
    if (cached) {
      return { value: cached, unreachable: false };
    }
  }
  if (envValue) {
    return { value: envValue, unreachable: false };
  }
  const result = await readCredentialResult(account);
  if (result.unreachable) {
    return { value: "", unreachable: true };
  }
  return { value: result.value?.trim() ?? "", unreachable: false };
}

async function readAuthPrerequisites(): Promise<{
  apiKey: string;
  baseUrl: string;
  unreachable: boolean;
}> {
  const envKey = envTrim("ASSISTANT_API_KEY");
  const envUrl = envTrim("VELLUM_PLATFORM_URL").replace(/\/+$/, "");

  const [apiKeyRead, baseUrlRead] = await Promise.all([
    readCredentialOrEnv(ASSISTANT_API_KEY_ACCOUNT, envKey),
    readCredentialOrEnv(PLATFORM_BASE_URL_ACCOUNT, envUrl),
  ]);

  const apiKey = apiKeyRead.value;
  const baseUrl = baseUrlRead.value.replace(/\/+$/, "");
  const unreachable =
    (!apiKey && apiKeyRead.unreachable) ||
    (!baseUrl && baseUrlRead.unreachable);

  return { apiKey, baseUrl, unreachable };
}

/**
 * Load in-memory platform ids from validate when they are missing or the
 * API key / base URL that produced them has changed.
 *
 * No-ops when assistant id and user id are already bound to the current
 * credentials, when auth prerequisites are missing, or when a failed
 * validate for the same credentials is still inside the cooldown window.
 * Concurrent callers share one in-flight request.
 */
export async function ensurePlatformIdentityIds(): Promise<void> {
  if (!ensureInFlight) {
    ensureInFlight = (async () => {
      try {
        const { apiKey, baseUrl, unreachable } = await readAuthPrerequisites();
        if (!apiKey || !baseUrl) {
          lastEnsureUnreachable = unreachable;
          return;
        }
        lastEnsureUnreachable = false;
        const fingerprint = identityFingerprint(apiKey, baseUrl);
        if (hasBoundIdentity() && identityBoundToFingerprint === fingerprint) {
          return;
        }
        if (hasBoundIdentity() && identityBoundToFingerprint === undefined) {
          identityBoundToFingerprint = fingerprint;
          return;
        }
        if (
          identityBoundToFingerprint !== undefined &&
          identityBoundToFingerprint !== fingerprint
        ) {
          clearPlatformIdentityOverrides();
          identityBoundToFingerprint = undefined;
        }
        if (
          Date.now() < nextEnsureAttemptAt &&
          lastAttemptFingerprint === fingerprint
        ) {
          return;
        }
        lastAttemptFingerprint = fingerprint;
        const ids = await fetchPlatformIdentityIds(baseUrl, apiKey);
        if (!ids) {
          nextEnsureAttemptAt = Date.now() + ENSURE_COOLDOWN_MS;
          return;
        }
        applyPlatformIdentityIds(ids);
        identityBoundToFingerprint = fingerprint;
        nextEnsureAttemptAt = 0;
        log.info(
          {
            hasAssistantId: Boolean(getPlatformAssistantId()),
            hasOrganizationId: Boolean(getPlatformOrganizationId()),
            hasUserId: Boolean(getPlatformUserId()),
          },
          "Loaded platform identity from platform validate",
        );
      } finally {
        ensureInFlight = null;
      }
    })();
  }
  await ensureInFlight;
}

export async function resolvePlatformAssistantId(): Promise<string> {
  await ensurePlatformIdentityIds();
  return getPlatformAssistantId();
}

export function peekPlatformAssistantId(): string | undefined {
  const id = getPlatformAssistantId();
  return id || undefined;
}

export async function resolvePlatformAssistantIdOrUndefined(): Promise<
  string | undefined
> {
  const id = await resolvePlatformAssistantId();
  return id || undefined;
}

export async function resolvePlatformUserId(): Promise<string> {
  await ensurePlatformIdentityIds();
  return getPlatformUserId();
}

/**
 * Resolve the bound platform owner id for managed-mode edge auth.
 *
 * `unreachable: true` only when the credential store is down, no API key
 * and/or platform base URL is available from env/last-good cache, and no
 * prior successful resolve is cached. A cached owner is returned with
 * `unreachable: false` so callers keep treating the assistant as reachable.
 */
export async function readStoredPlatformUserId(): Promise<StoredPlatformUserId> {
  const userId = await resolvePlatformUserId();
  if (userId) {
    return { userId, unreachable: false };
  }
  return { userId: undefined, unreachable: lastEnsureUnreachable };
}
