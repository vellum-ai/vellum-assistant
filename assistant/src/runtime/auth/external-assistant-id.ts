/**
 * External assistant ID resolver.
 *
 * Resolves the external assistant ID for use in edge-facing JWT tokens
 * (aud=vellum-gateway). The external ID is needed because the gateway
 * must identify which assistant the token belongs to, while the daemon
 * internally uses 'self'.
 *
 * Resolution order:
 *   1. Cached in-memory value (populated on first call)
 *   2. VELLUM_ASSISTANT_NAME env var (set by CLI hatch / Docker setup)
 *   3. BASE_DATA_DIR path matching `/assistants/<name>` or `/instances/<name>` suffix
 *   4. `undefined` — callers must handle the missing value
 *
 * The value is cached in memory after the first successful read.
 */

import { getBaseDataDir } from "../../config/env-registry.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("external-assistant-id");

let cached: string | null | undefined;

/**
 * Get the external assistant ID.
 *
 * Resolution order:
 *   1. Cached in-memory value (populated on first call)
 *   2. VELLUM_ASSISTANT_NAME env var (set by CLI hatch / Docker setup)
 *   3. BASE_DATA_DIR path matching `/assistants/<name>` or `/instances/<name>` suffix
 *   4. `undefined` when resolution fails entirely
 */
export function getExternalAssistantId(): string | undefined {
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  // Primary: env var set by CLI hatch / Docker setup
  const envName = process.env.VELLUM_ASSISTANT_NAME;
  if (envName) {
    cached = envName;
    log.info(
      { externalAssistantId: cached },
      "Resolved external assistant ID from VELLUM_ASSISTANT_NAME",
    );
    return cached;
  }

  // Fallback: derive from BASE_DATA_DIR path
  const base = getBaseDataDir();
  if (base && typeof base === "string") {
    const normalized = base.replace(/\\/g, "/").replace(/\/+$/, "");
    const match = normalized.match(/\/(?:assistants|instances)\/([^/]+)$/);
    if (match) {
      cached = match[1];
      log.info(
        { externalAssistantId: cached },
        "Resolved external assistant ID from BASE_DATA_DIR",
      );
      return cached;
    }
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
