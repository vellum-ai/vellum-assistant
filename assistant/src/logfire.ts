import { LOGFIRE_ENABLED } from './flags.js';
import { APP_VERSION } from './version.js';
import { getLogger } from './util/logger.js';

const log = getLogger('logfire');

type LogfireModule = typeof import('@pydantic/logfire-node');

let logfireInstance: LogfireModule | null = null;

/**
 * Initialize Logfire for LLM observability.
 * Dynamically imports @pydantic/logfire-node only when LOGFIRE_ENABLED is true.
 * Non-fatal on failure (logs warning and continues).
 */
export async function initLogfire(): Promise<void> {
  if (!LOGFIRE_ENABLED) return;

  try {
    const logfire = await import('@pydantic/logfire-node');
    logfire.configure({
      token: process.env.LOGFIRE_TOKEN,
      serviceName: 'vellum-assistant',
      serviceVersion: APP_VERSION,
    });
    logfireInstance = logfire;
    log.info('Logfire initialized');
  } catch (err) {
    log.warn({ err }, 'Failed to initialize Logfire — LLM observability disabled');
  }
}

/** Returns the logfire module instance, or null if not initialized. */
export function getLogfire(): LogfireModule | null {
  return logfireInstance;
}
