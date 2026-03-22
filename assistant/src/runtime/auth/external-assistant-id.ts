/**
 * External assistant ID resolver.
 *
 * Resolves the external assistant ID for use in edge-facing JWT tokens
 * (aud=vellum-gateway). The external ID is needed because the gateway
 * must identify which assistant the token belongs to, while the daemon
 * internally uses 'self'.
 *
 * Reads from the VELLUM_ASSISTANT_NAME env var, which is set by CLI
 * hatch and Docker setup. Returns `undefined` if the env var is not set.
 *
 * The value is cached in memory after the first read.
 */

import { getLogger } from "../../util/logger.js";

const log = getLogger("external-assistant-id");

let cached: string | null | undefined;

/**
 * Get the external assistant ID from the VELLUM_ASSISTANT_NAME env var.
 * Returns `undefined` when the env var is not set.
 */
export function getExternalAssistantId(): string | undefined {
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const envName = process.env.VELLUM_ASSISTANT_NAME;
  if (envName) {
    cached = envName;
    log.info(
      { externalAssistantId: cached },
      "Resolved external assistant ID from VELLUM_ASSISTANT_NAME",
    );
    return cached;
  }

  cached = null;
  return undefined;
}

/**
 * Reset the cached external assistant ID. Used by tests to force
 * re-resolution on the next call.
 */
export function resetExternalAssistantIdCache(): void {
  cached = undefined;
}
