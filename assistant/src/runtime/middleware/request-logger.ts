/**
 * HTTP request/response logging middleware.
 *
 * Logs method, path, status, and latency for every request to aid
 * debugging client issues. Uses structured Pino logging.
 */

import { getLogger } from "../../util/logger.js";

const log = getLogger("http-request");

const UNKNOWN = "unknown" as const;

/**
 * Wrap a request handler to log request metadata and response timing.
 *
 * The handler may return `undefined` for WebSocket upgrades (Bun consumes
 * the request and there is no HTTP response to send).
 */
export async function withRequestLogging(
  req: Request,
  handler: () => Promise<Response>,
): Promise<Response> {
  const start = performance.now();
  const url = new URL(req.url);
  const method = req.method;
  const path = url.pathname;

  let response: Response;
  try {
    response = await handler();
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    log.error(
      { method, path, latencyMs, err },
      `${method} ${path} -> error (${latencyMs}ms)`,
    );
    throw err;
  }

  const latencyMs = Math.round(performance.now() - start);

  // WebSocket upgrades return undefined — log and pass through without
  // dereferencing response properties.
  if (!response) {
    log.info(
      { method, path, latencyMs },
      `${method} ${path} -> ws-upgrade (${latencyMs}ms)`,
    );
    return response;
  }

  const status = response.status;

  const logData = {
    method,
    path,
    status,
    latencyMs,
    interfaceId: req.headers.get("x-vellum-interface-id") ?? UNKNOWN,
    contentType: req.headers.get("content-type") ?? UNKNOWN,
    userAgent: req.headers.get("user-agent") ?? UNKNOWN,
  };

  if (status >= 500) {
    log.error(logData, `${method} ${path} -> ${status} (${latencyMs}ms)`);
  } else if (status >= 400) {
    log.warn(logData, `${method} ${path} -> ${status} (${latencyMs}ms)`);
  } else {
    log.info(logData, `${method} ${path} -> ${status} (${latencyMs}ms)`);
  }

  return response;
}
