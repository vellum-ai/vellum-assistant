/**
 * Rehydrate the in-memory platform identity/URL overrides at process startup.
 *
 * These overrides (`setPlatformBaseUrl` and the platform ID setters in
 * `config/env.ts`) are normally only populated at runtime by the secret-routes
 * handlers when the platform pushes values. Any standalone process that talks
 * to the platform — the daemon and the schedule worker — must rehydrate them
 * before its first request, otherwise `getPlatformBaseUrl()` falls back to the
 * environment default (e.g. dev-platform) while the credential store holds the
 * real production values, and requests are sent to the wrong environment.
 *
 * Bound platform ids come from `POST /v1/internal/assistants/validate/`,
 * which trades the assistant API key for assistant/organization/user ids.
 * Vault leftovers for those three fields are a last-resort fallback so a
 * validate outage does not drop identity on existing installs.
 *
 * Each field is best-effort: a credential-store read failure is logged and
 * skipped so a single missing value never blocks startup.
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
  setPlatformBaseUrl,
  setPlatformOrganizationId,
  setPlatformUserId,
} from "./env.js";
import {
  applyPlatformIdentityIds,
  fetchPlatformIdentityIds,
} from "./platform-identity.js";

const log = getLogger("platform-rehydration");

async function rehydrateField(
  name: string,
  apply: (value: string) => void,
  label: string,
): Promise<void> {
  try {
    const key = credentialKey("vellum", name);
    const persisted = (await getSecureKeyAsync(key))?.trim();
    if (persisted) {
      apply(persisted);
      log.info(`Rehydrated ${label} from credential store`);
    }
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      `Failed to rehydrate ${label} from credential store (non-fatal)`,
    );
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
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to read assistant API key from credential store (non-fatal)",
    );
  }
  return process.env.ASSISTANT_API_KEY?.trim() ?? "";
}

async function rehydrateIdentityFromValidate(): Promise<boolean> {
  const apiKey = await readAssistantApiKey();
  if (!apiKey) {
    return false;
  }
  const baseUrl = getPlatformBaseUrl();
  if (!baseUrl) {
    return false;
  }
  const ids = await fetchPlatformIdentityIds(baseUrl, apiKey);
  if (!ids) {
    return false;
  }
  applyPlatformIdentityIds(ids);
  log.info("Rehydrated platform identity from platform validate");
  return true;
}

/**
 * Rehydrate the platform base URL and the related platform IDs (assistant,
 * organization, user). Safe to call more than once.
 */
export async function rehydratePlatformCredentials(): Promise<void> {
  // Base URL first so managed proxy activation and identity validate resolve
  // the correct environment for every request that follows.
  await rehydrateField(
    "platform_base_url",
    setPlatformBaseUrl,
    "platform base URL",
  );

  await rehydrateIdentityFromValidate();

  if (!getPlatformAssistantId()) {
    await rehydrateField(
      "platform_assistant_id",
      setPlatformAssistantId,
      "platform assistant ID",
    );
  }
  if (!getPlatformOrganizationId()) {
    await rehydrateField(
      "platform_organization_id",
      setPlatformOrganizationId,
      "platform organization ID",
    );
  }
  if (!getPlatformUserId()) {
    await rehydrateField(
      "platform_user_id",
      setPlatformUserId,
      "platform user ID",
    );
  }
}
