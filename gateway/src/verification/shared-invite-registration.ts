/**
 * Registers a `vellum-shared` invite with the platform, which routes the
 * invitee's redemption back to this assistant. The platform receives only the
 * link-token hash and the invite's expiry, never the token itself.
 */

import { hashInviteToken } from "@vellumai/gateway-client";

import { credentialKey } from "../credential-key.js";
import { readCredentialResult } from "../credential-reader.js";
import { fetchImpl } from "../fetch.js";
import {
  arePlatformFeaturesEnabled,
  isFeatureFlagEnabled,
} from "../feature-flag-resolver.js";
import { getLogger } from "../logger.js";

const log = getLogger("shared-invite-registration");

const SHARED_INVITE_CHANNEL = "vellum-shared";
const SHARED_INVITE_REGISTRATION_PATH = "/v1/internal/shared-invites/";

const TRUSTED_CONTACTS_FLAG = "vellum-trusted-contacts";
const REGISTRATION_TIMEOUT_MS = 10_000;

export type SharedInviteRegistrationResult =
  /** Registered, or nothing to register for this invite or gateway. */
  | { status: "registered" | "skipped" }
  /** The platform already holds this hash. */
  | { status: "duplicate" }
  /** The platform refused another outstanding invite. */
  | { status: "limit_reached" }
  /** The credential store could not be read. */
  | { status: "unavailable" }
  /** Any other refusal or transport failure. */
  | { status: "failed" };

/**
 * Store value when present, else the environment fallback. `unreachable` is
 * set only when the store could not be read and no fallback exists.
 */
async function readPlatformCredential(
  field: "platform_base_url" | "assistant_api_key",
  envName: string,
): Promise<{ value: string; unreachable: boolean }> {
  const stored = await readCredentialResult(credentialKey("vellum", field));
  const value = stored.value?.trim() || process.env[envName]?.trim() || "";
  return { value, unreachable: !value && stored.unreachable };
}

/**
 * Register the invite's link-token hash and expiry with the platform.
 *
 * Skipped for any channel other than `vellum-shared`, while the
 * trusted-contacts flag is off, when platform features are disabled, and when
 * no platform credentials are configured.
 */
export async function registerSharedInvite(params: {
  sourceChannel: string;
  rawToken: string;
  expiresAt: number;
}): Promise<SharedInviteRegistrationResult> {
  if (
    params.sourceChannel !== SHARED_INVITE_CHANNEL ||
    !isFeatureFlagEnabled(TRUSTED_CONTACTS_FLAG) ||
    !arePlatformFeaturesEnabled()
  ) {
    return { status: "skipped" };
  }

  const [baseUrl, apiKey] = await Promise.all([
    readPlatformCredential("platform_base_url", "VELLUM_PLATFORM_URL"),
    readPlatformCredential("assistant_api_key", "ASSISTANT_API_KEY"),
  ]);
  if (baseUrl.unreachable || apiKey.unreachable) {
    log.warn("Shared invite registration: credential store unreachable");
    return { status: "unavailable" };
  }
  if (!baseUrl.value || !apiKey.value) {
    log.debug(
      { hasPlatformBaseUrl: !!baseUrl.value, hasApiKey: !!apiKey.value },
      "Shared invite registration skipped: no platform credentials",
    );
    return { status: "skipped" };
  }

  const url = `${baseUrl.value.replace(/\/+$/, "")}${SHARED_INVITE_REGISTRATION_PATH}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${apiKey.value}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code_hash: hashInviteToken(params.rawToken),
        expires_at: Math.floor(params.expiresAt),
      }),
      signal: AbortSignal.timeout(REGISTRATION_TIMEOUT_MS),
    });
  } catch (err) {
    log.warn({ err }, "Shared invite registration request failed");
    return { status: "failed" };
  }

  if (response.ok) {
    return { status: "registered" };
  }
  log.warn(
    { status: response.status },
    "Shared invite registration refused by the platform",
  );
  if (response.status === 409) {
    return { status: "duplicate" };
  }
  if (response.status === 429) {
    return { status: "limit_reached" };
  }
  return { status: "failed" };
}
