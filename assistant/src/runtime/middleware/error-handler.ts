/**
 * Centralized error handling for runtime HTTP request dispatch.
 */

import { mapGatewayIpcConnectError } from "../../ipc/gateway-ipc-errors.js";
import { ConfigError, ProviderNotConfiguredError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import type { HttpErrorCode } from "../http-errors.js";
import { httpError } from "../http-errors.js";
import { RouteError } from "../routes/errors.js";

const log = getLogger("runtime-http");

/**
 * Wrap an async endpoint handler with standard error handling.
 * Catches ConfigError (422), RouteError (including gateway IPC 503), and
 * generic errors (500).
 */
export async function withErrorHandling(
  endpoint: string,
  handler: () => Promise<Response>,
): Promise<Response> {
  try {
    return await handler();
  } catch (err) {
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
    const mapped = mapGatewayIpcConnectError(err);
    if (mapped instanceof RouteError) {
      log.warn({ err: mapped, endpoint }, "Runtime HTTP route error");
      return httpError(
        mapped.code as HttpErrorCode,
        mapped.message,
        mapped.statusCode,
        mapped.details,
      );
    }
    log.error({ err: mapped, endpoint }, "Runtime HTTP handler error");
    const message =
      mapped instanceof Error ? mapped.message : "Internal server error";
    return httpError("INTERNAL_ERROR", message, 500);
  }
}
