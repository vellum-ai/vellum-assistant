/**
 * Bound platform identity (assistant, organization, user).
 *
 * Django maps an assistant API key to these ids via
 * `POST /v1/internal/assistants/validate/`. Process startup rehydrates from
 * that endpoint into the in-memory overrides. Resolution reads those
 * overrides (and `PLATFORM_ORGANIZATION_ID` / `PLATFORM_USER_ID` when set).
 * When the in-memory assistant id is empty, the next resolve retries
 * validate (single-flight, with a cooldown after a failed attempt).
 */

import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import {
  getPlatformAssistantId,
  getPlatformBaseUrl,
  getPlatformOrganizationId,
  getPlatformUserId,
  setPlatformAssistantId,
  setPlatformOrganizationId,
  setPlatformUserId,
} from "./env.js";

const log = getLogger("platform-identity");

export const PLATFORM_IDENTITY_VALIDATE_PATH =
  "/v1/internal/assistants/validate/";

const VALIDATE_TIMEOUT_MS = 5_000;
const ENSURE_COOLDOWN_MS = 10_000;

export type PlatformIdentityIds = {
  assistantId: string;
  organizationId: string;
  userId: string;
};

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function applyPlatformIdentityIds(ids: PlatformIdentityIds): void {
  if (ids.assistantId) {
    setPlatformAssistantId(ids.assistantId);
  }
  if (ids.organizationId) {
    setPlatformOrganizationId(ids.organizationId);
  }
  if (ids.userId) {
    setPlatformUserId(ids.userId);
  }
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
    const res = await fetch(url, {
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

async function readAssistantApiKey(): Promise<string> {
  try {
    const stored = (
      await getSecureKeyAsync(credentialKey("vellum", "assistant_api_key"))
    )?.trim();
    if (stored) {
      return stored;
    }
  } catch (err) {
    log.warn({ err }, "failed to read assistant API key from credential store");
  }
  return process.env.ASSISTANT_API_KEY?.trim() ?? "";
}

let ensureInFlight: Promise<void> | null = null;
let nextEnsureAttemptAt = 0;

export function _resetPlatformIdentityEnsureForTests(): void {
  ensureInFlight = null;
  nextEnsureAttemptAt = 0;
}

/**
 * Load in-memory platform ids from validate when they are missing.
 *
 * No-ops when the assistant id is already set, when auth prerequisites are
 * missing, or when a failed attempt is still inside the cooldown window.
 * Concurrent callers share one in-flight request.
 */
export async function ensurePlatformIdentityIds(): Promise<void> {
  if (getPlatformAssistantId()?.trim()) {
    return;
  }
  if (Date.now() < nextEnsureAttemptAt) {
    return;
  }
  if (!ensureInFlight) {
    ensureInFlight = (async () => {
      try {
        const apiKey = await readAssistantApiKey();
        const baseUrl = (getPlatformBaseUrl() ?? "").replace(/\/+$/, "");
        if (!apiKey || !baseUrl) {
          return;
        }
        const ids = await fetchPlatformIdentityIds(baseUrl, apiKey);
        if (!ids) {
          nextEnsureAttemptAt = Date.now() + ENSURE_COOLDOWN_MS;
          return;
        }
        applyPlatformIdentityIds(ids);
        nextEnsureAttemptAt = 0;
        log.info("Loaded platform identity from platform validate");
      } finally {
        ensureInFlight = null;
      }
    })();
  }
  await ensureInFlight;
}

export async function resolvePlatformAssistantId(): Promise<string> {
  const existing = getPlatformAssistantId()?.trim() ?? "";
  if (existing) {
    return existing;
  }
  await ensurePlatformIdentityIds();
  return getPlatformAssistantId()?.trim() ?? "";
}

export async function resolvePlatformAssistantIdOrNull(): Promise<
  string | null
> {
  const id = await resolvePlatformAssistantId();
  return id || null;
}

export async function resolvePlatformOrganizationId(): Promise<string> {
  const existing = getPlatformOrganizationId()?.trim() ?? "";
  if (existing) {
    return existing;
  }
  await ensurePlatformIdentityIds();
  return getPlatformOrganizationId()?.trim() ?? "";
}

export async function resolvePlatformUserId(): Promise<string> {
  const existing = getPlatformUserId()?.trim() ?? "";
  if (existing) {
    return existing;
  }
  await ensurePlatformIdentityIds();
  return getPlatformUserId()?.trim() ?? "";
}
