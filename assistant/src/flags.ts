import { APP_VERSION } from './version.js';

/** Enable Logfire LLM observability. Dev-only + requires LOGFIRE_TOKEN + VELLUM_ENABLE_MONITORING=1. */
export const LOGFIRE_ENABLED: boolean =
  APP_VERSION === '0.0.0-dev' &&
  !!process.env.LOGFIRE_TOKEN &&
  process.env.VELLUM_ENABLE_MONITORING === '1';
