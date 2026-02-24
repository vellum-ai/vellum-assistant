/**
 * Centralized error handling for runtime HTTP request dispatch.
 */

import { ConfigError, IngressBlockedError } from '../../util/errors.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('runtime-http');

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
      log.warn({ endpoint, detectedTypes: err.detectedTypes }, 'Blocked HTTP request containing secrets');
      return Response.json({ error: err.message, code: err.code }, { status: 422 });
    }
    if (err instanceof ConfigError) {
      log.warn({ err, endpoint }, 'Runtime HTTP config error');
      return Response.json({ error: err.message, code: err.code }, { status: 422 });
    }
    log.error({ err, endpoint }, 'Runtime HTTP handler error');
    const message = err instanceof Error ? err.message : 'Internal server error';
    return Response.json({ error: message }, { status: 500 });
  }
}
