/**
 * Bound platform identity (assistant, organization, user).
 *
 * Django maps an assistant API key to these ids via
 * `POST /v1/internal/assistants/validate/`. Process startup rehydrates from
 * that endpoint. Vault leftovers (`vellum:platform_*`) are a last-resort
 * fallback until hatch stops writing them.
 */

import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import {
  getPlatformAssistantId,
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

async function readVaultField(field: string): Promise<string> {
  try {
    return (
      (await getSecureKeyAsync(credentialKey("vellum", field)))?.trim() ?? ""
    );
  } catch (err) {
    log.warn(
      { err, field },
      "failed to read platform identity from credential store",
    );
    return "";
  }
}

export async function resolvePlatformAssistantId(): Promise<string> {
  return (
    getPlatformAssistantId().trim() ||
    (await readVaultField("platform_assistant_id"))
  );
}

export async function resolvePlatformAssistantIdOrNull(): Promise<
  string | null
> {
  const id = await resolvePlatformAssistantId();
  return id || null;
}

export async function resolvePlatformOrganizationId(): Promise<string> {
  return (
    getPlatformOrganizationId().trim() ||
    (await readVaultField("platform_organization_id"))
  );
}

export async function resolvePlatformUserId(): Promise<string> {
  return (
    getPlatformUserId().trim() || (await readVaultField("platform_user_id"))
  );
}
