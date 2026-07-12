/**
 * Rehydrate the in-memory platform identity/URL overrides from the credential
 * store at process startup.
 *
 * These overrides (`setPlatformBaseUrl` and the platform ID setters in
 * `config/env.ts`) are normally only populated at runtime by the secret-routes
 * handlers when the platform pushes values. Any standalone process that talks
 * to the platform — the daemon and the schedule worker — must rehydrate them
 * before its first request, otherwise `getPlatformBaseUrl()` falls back to the
 * environment default (e.g. dev-platform) while the credential store holds the
 * real production values, and requests are sent to the wrong environment.
 *
 * Each field is best-effort: a credential-store read failure is logged and
 * skipped so a single missing value never blocks startup.
 */
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import {
  setPlatformAssistantId,
  setPlatformBaseUrl,
  setPlatformOrganizationId,
  setPlatformUserId,
} from "./env.js";

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

/**
 * Rehydrate the platform base URL and the related platform IDs (assistant,
 * organization, user) from the credential store into their in-memory
 * overrides. Safe to call more than once.
 */
export async function rehydratePlatformCredentials(): Promise<void> {
  // Base URL first so managed proxy activation resolves the correct
  // environment for the ID lookups and every request that follows.
  await rehydrateField(
    "platform_base_url",
    setPlatformBaseUrl,
    "platform base URL",
  );
  await rehydrateField(
    "platform_assistant_id",
    setPlatformAssistantId,
    "platform assistant ID",
  );
  await rehydrateField(
    "platform_organization_id",
    setPlatformOrganizationId,
    "platform organization ID",
  );
  await rehydrateField(
    "platform_user_id",
    setPlatformUserId,
    "platform user ID",
  );
}
