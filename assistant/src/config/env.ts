/**
 * Centralized environment variable access with validation.
 *
 * All runtime environment variables should be accessed through this module
 * instead of reading process.env directly. This provides:
 * - Single source of truth for env var names and defaults
 * - Type-safe accessors (string, number, boolean)
 * - Fail-fast validation via validateEnv() at startup
 * - Shared derived values (e.g. gateway base URL) instead of duplicated logic
 *
 * Variables NOT centralized here (must resolve before this module loads):
 * - BASE_DATA_DIR, VELLUM_DAEMON_* — bootstrap/platform layer (util/platform.ts)
 * - VELLUM_DEBUG, BUN_TEST, NODE_ENV log flags — logger init (util/logger.ts)
 * - APP_VERSION — compile-time embedding (version.ts)
 * - __EVAL_INPUT_JSON, __SKILL_*_JSON — internal sandbox IPC
 */

import { getLogger } from '../util/logger.js';

const log = getLogger('env');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Read an env var as a trimmed non-empty string, or undefined. */
function str(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || undefined;
}

/** Read an env var as an integer with fallback. Returns undefined if not set and no fallback given. */
function int(name: string, fallback: number): number;
function int(name: string): number | undefined;
function int(name: string, fallback?: number): number | undefined {
  const raw = str(name);
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (isNaN(n)) {
    throw new Error(`Invalid integer for ${name}: "${raw}"${fallback !== undefined ? ` (fallback: ${fallback})` : ''}`);
  }
  return n;
}

/** Read an env var as a boolean flag ('true'/'1' → true, everything else → false). */
function flag(name: string): boolean {
  const raw = str(name);
  return raw === 'true' || raw === '1';
}

// ── Gateway ──────────────────────────────────────────────────────────────────

const DEFAULT_GATEWAY_PORT = 7830;

export function getGatewayPort(): number {
  return int('GATEWAY_PORT', DEFAULT_GATEWAY_PORT);
}

/**
 * Resolve the gateway base URL for internal service-to-service calls.
 * Prefers GATEWAY_INTERNAL_BASE_URL if set, otherwise derives from port.
 */
export function getGatewayInternalBaseUrl(): string {
  const explicit = str('GATEWAY_INTERNAL_BASE_URL');
  if (explicit) return explicit.replace(/\/+$/, '');
  return `http://127.0.0.1:${getGatewayPort()}`;
}

// ── Ingress ──────────────────────────────────────────────────────────────────

/** Read the INGRESS_PUBLIC_BASE_URL env var (may be mutated at runtime by config handlers). */
export function getIngressPublicBaseUrl(): string | undefined {
  return str('INGRESS_PUBLIC_BASE_URL');
}

/** Set or clear the INGRESS_PUBLIC_BASE_URL env var (used by config handlers). */
export function setIngressPublicBaseUrl(value: string | undefined): void {
  if (value) {
    process.env.INGRESS_PUBLIC_BASE_URL = value;
  } else {
    delete process.env.INGRESS_PUBLIC_BASE_URL;
  }
}

// ── Runtime HTTP ─────────────────────────────────────────────────────────────

export function getRuntimeHttpPort(): number | undefined {
  return int('RUNTIME_HTTP_PORT');
}

export function getRuntimeHttpHost(): string {
  return str('RUNTIME_HTTP_HOST') || '127.0.0.1';
}

export function getRuntimeProxyBearerToken(): string | undefined {
  return str('RUNTIME_PROXY_BEARER_TOKEN');
}

export function getRuntimeGatewayOriginSecret(): string | undefined {
  return str('RUNTIME_GATEWAY_ORIGIN_SECRET');
}

export function isHttpAuthDisabled(): boolean {
  return str('DISABLE_HTTP_AUTH')?.toLowerCase() === 'true';
}

// ── Twilio ───────────────────────────────────────────────────────────────────

export function getTwilioPhoneNumberEnv(): string | undefined {
  return str('TWILIO_PHONE_NUMBER');
}

export function getTwilioUserPhoneNumber(): string | undefined {
  return str('TWILIO_USER_PHONE_NUMBER');
}

export function getTwilioWssBaseUrl(): string | undefined {
  return str('TWILIO_WSS_BASE_URL');
}

export function isTwilioWebhookValidationDisabled(): boolean {
  // Intentionally strict: only exact "true" disables validation (not "1").
  // This is a security-sensitive bypass — we don't want environments that
  // template booleans as "1" to silently skip webhook signature checks.
  return process.env.TWILIO_WEBHOOK_VALIDATION_DISABLED === 'true';
}

export function getCallWelcomeGreeting(): string | undefined {
  return str('CALL_WELCOME_GREETING');
}

// ── Monitoring ───────────────────────────────────────────────────────────────

export function getLogfireToken(): string | undefined {
  return str('LOGFIRE_TOKEN');
}

export function isMonitoringEnabled(): boolean {
  return flag('VELLUM_ENABLE_MONITORING');
}

export function getSentryDsn(): string | undefined {
  return str('SENTRY_DSN');
}

// ── Qdrant ───────────────────────────────────────────────────────────────────

export function getQdrantUrlEnv(): string | undefined {
  return str('QDRANT_URL');
}

// ── Ollama ───────────────────────────────────────────────────────────────────

export function getOllamaBaseUrlEnv(): string | undefined {
  return str('OLLAMA_BASE_URL');
}

// ── Startup validation ──────────────────────────────────────────────────────

/**
 * Validate environment at startup. Call early in daemon lifecycle
 * (after dotenv loads). Throws on invalid required values; warns on
 * deprecated vars.
 */
export function validateEnv(): void {
  const gatewayPort = getGatewayPort();
  if (gatewayPort < 1 || gatewayPort > 65535) {
    throw new Error(`Invalid GATEWAY_PORT: ${gatewayPort} (must be 1-65535)`);
  }

  const httpPort = getRuntimeHttpPort();
  if (httpPort !== undefined && (httpPort < 1 || httpPort > 65535)) {
    throw new Error(`Invalid RUNTIME_HTTP_PORT: ${httpPort} (must be 1-65535)`);
  }

  if (getTwilioWssBaseUrl()) {
    log.warn('TWILIO_WSS_BASE_URL env var is deprecated. Relay URL is now derived from ingress.publicBaseUrl.');
  }
}
