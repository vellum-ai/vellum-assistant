/**
 * Business logic for Vercel API token management.
 *
 * The Vercel token is stored in the secure credential vault under
 * `credential/vercel/api_token`. These functions provide get/set/delete
 * operations that mirror the pattern used by Telegram config handlers.
 */

import { credentialKey } from "../../security/credential-key.js";
import {
  deleteSecureKeyAsync,
  getSecureKeyAsync,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import {
  deleteCredentialMetadata,
  upsertCredentialMetadata,
} from "../../tools/credentials/metadata-store.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("config-vercel");

// -- Transport-agnostic result type --

export interface VercelConfigResult {
  hasToken: boolean;
  success: boolean;
  error?: string;
}

/**
 * Check whether a Vercel API token is stored in the credential vault.
 */
export async function getVercelConfig(): Promise<VercelConfigResult> {
  const token = await getSecureKeyAsync(credentialKey("vercel", "api_token"));
  return { hasToken: !!token, success: true };
}

/**
 * Store a Vercel API token in the credential vault.
 */
export async function setVercelConfig(
  apiToken?: string,
): Promise<VercelConfigResult> {
  if (!apiToken) {
    return { hasToken: false, success: false, error: "apiToken is required" };
  }

  const stored = await setSecureKeyAsync(
    credentialKey("vercel", "api_token"),
    apiToken,
  );
  if (!stored) {
    return {
      hasToken: false,
      success: false,
      error: "Failed to store Vercel API token in secure storage",
    };
  }

  upsertCredentialMetadata("vercel", "api_token", {
    allowedTools: ["deploy", "publish_page"],
  });

  log.info("Vercel API token stored successfully");
  return { hasToken: true, success: true };
}

/**
 * Delete the Vercel API token from the credential vault.
 */
export async function deleteVercelConfig(): Promise<VercelConfigResult> {
  const result = await deleteSecureKeyAsync(
    credentialKey("vercel", "api_token"),
  );

  if (result === "error") {
    const stillPresent = !!(await getSecureKeyAsync(
      credentialKey("vercel", "api_token"),
    ));
    return {
      hasToken: stillPresent,
      success: false,
      error: "Failed to delete Vercel API token from secure storage",
    };
  }

  deleteCredentialMetadata("vercel", "api_token");

  log.info("Vercel API token deleted");
  return { hasToken: false, success: true };
}
