/**
 * HTTP request/response logging middleware.
 *
 * Logs method, path, status, and latency for every request to aid
 * debugging client issues. Uses structured Pino logging.
 */

import { getLogger } from '../../util/logger.js';

const log = getLogger('http-request');

/**
 * Wrap a request handler to log request metadata and response timing.
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
  const status = response.status;

  const logData = {
    method,
    path,
    status,
    latencyMs,
    contentType: req.headers.get('content-type') ?? undefined,
    userAgent: req.headers.get('user-agent') ?? undefined,
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
