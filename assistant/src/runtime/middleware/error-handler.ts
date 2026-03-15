/**
 * Centralized error handling for runtime HTTP request dispatch.
 */

import {
  ConfigError,
  IngressBlockedError,
  ProviderNotConfiguredError,
} from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";

const log = getLogger("runtime-http");

/**
 * Wrap an async endpoint handler with standard error handling.
 * Catches IngressBlockedError (422), ConfigError (422), and generic errors (500).
 */
export async function withErrorHandling(
  endpoint: string,
  handler: () => Promise<Response>,
): Promise<Response> {
  try {
    return await handler();
  } catch (err) {
    if (err instanceof IngressBlockedError) {
      log.warn(
        { endpoint, detectedTypes: err.detectedTypes },
        "Blocked HTTP request containing secrets",
      );
      return httpError("UNPROCESSABLE_ENTITY", err.message, 422);
    }
    if (err instanceof ProviderNotConfiguredError) {
      log.warn({ err, endpoint }, "No LLM provider configured");
      return httpError(
        "UNPROCESSABLE_ENTITY",
        `No API key configured for ${err.requestedProvider}. Run \`keys set ${err.requestedProvider} <key>\` or configure it from the Settings page under API Keys.`,
        422,
      );
    }
    if (err instanceof ConfigError) {
      log.warn({ err, endpoint }, "Runtime HTTP config error");
      return httpError("UNPROCESSABLE_ENTITY", err.message, 422);
    }
    log.error({ err, endpoint }, "Runtime HTTP handler error");
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return httpError("INTERNAL_ERROR", message, 500);
  }
}
