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
 * Bootstrap-level env vars (BASE_DATA_DIR, DEBUG_STDOUT_LOGS) are defined
 * in config/env-registry.ts which has no internal dependencies and can be
 * imported from platform/logger without circular imports.
 */

import { getLogger } from "../util/logger.js";
import { checkUnrecognizedEnvVars } from "./env-registry.js";

const log = getLogger("env");

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
    throw new Error(
      `Invalid integer for ${name}: "${raw}"${
        fallback !== undefined ? ` (fallback: ${fallback})` : ""
      }`,
    );
  }
  return n;
}

// ── Gateway ──────────────────────────────────────────────────────────────────

const DEFAULT_GATEWAY_PORT = 7830;

export function getGatewayPort(): number {
  return int("GATEWAY_PORT", DEFAULT_GATEWAY_PORT);
}

/** Resolve the gateway base URL for internal service-to-service calls. */
export function getGatewayInternalBaseUrl(): string {
  return `http://127.0.0.1:${getGatewayPort()}`;
}

// ── Ingress ──────────────────────────────────────────────────────────────────

let _ingressPublicBaseUrl: string | undefined;

/** Read the ingress public base URL (module-level state, mutated at runtime by config handlers). */
export function getIngressPublicBaseUrl(): string | undefined {
  return _ingressPublicBaseUrl;
}

/** Set or clear the ingress public base URL (used by config handlers). */
export function setIngressPublicBaseUrl(value: string | undefined): void {
  _ingressPublicBaseUrl = value;
}

// ── Runtime HTTP ─────────────────────────────────────────────────────────────

export function getRuntimeHttpPort(): number {
  return int("RUNTIME_HTTP_PORT") ?? 7821;
}

export function getRuntimeHttpHost(): string {
  return str("RUNTIME_HTTP_HOST") || "127.0.0.1";
}

export function getRuntimeGatewayOriginSecret(): string | undefined {
  return str("RUNTIME_GATEWAY_ORIGIN_SECRET");
}

/**
 * True when HTTP API auth is disabled via DISABLE_HTTP_AUTH=true AND the
 * safety gate VELLUM_UNSAFE_AUTH_BYPASS=1 is also set. Without the safety
 * gate, the bypass is ignored.
 */
export function isHttpAuthDisabled(): boolean {
  if (str("DISABLE_HTTP_AUTH")?.toLowerCase() !== "true") return false;
  return str("VELLUM_UNSAFE_AUTH_BYPASS")?.trim() === "1";
}

/**
 * True when DISABLE_HTTP_AUTH is set but the safety gate
 * VELLUM_UNSAFE_AUTH_BYPASS=1 is missing — used for warning messages.
 */
export function hasUngatedHttpAuthDisabled(): boolean {
  if (str("DISABLE_HTTP_AUTH")?.toLowerCase() !== "true") return false;
  return str("VELLUM_UNSAFE_AUTH_BYPASS")?.trim() !== "1";
}

// ── Monitoring ───────────────────────────────────────────────────────────────

export function getLogfireToken(): string | undefined {
  return str("LOGFIRE_TOKEN");
}

const DEFAULT_SENTRY_DSN =
  "https://db2d38a082e4ee35eeaea08c44b376ec@o4504590528675840.ingest.us.sentry.io/4510874712276992";

export function getSentryDsn(): string {
  return str("SENTRY_DSN") ?? DEFAULT_SENTRY_DSN;
}

// ── Qdrant ───────────────────────────────────────────────────────────────────

export function getQdrantUrlEnv(): string | undefined {
  return str("QDRANT_URL");
}

export function getQdrantHttpPortEnv(): number | undefined {
  return int("QDRANT_HTTP_PORT");
}

// ── Ollama ───────────────────────────────────────────────────────────────────

export function getOllamaBaseUrlEnv(): string | undefined {
  return str("OLLAMA_BASE_URL");
}

// ── Platform ─────────────────────────────────────────────────────────────────

let _platformBaseUrlOverride: string | undefined;

export function setPlatformBaseUrl(value: string | undefined): void {
  _platformBaseUrlOverride = value;
}

export function getPlatformBaseUrl(): string {
  return str("PLATFORM_BASE_URL") ?? _platformBaseUrlOverride ?? "";
}

let _platformAssistantIdOverride: string | undefined;

export function setPlatformAssistantId(value: string | undefined): void {
  _platformAssistantIdOverride = value;
}

/**
 * PLATFORM_ASSISTANT_ID — UUID of this assistant on the platform.
 * Required for registering callback routes when containerized.
 */
export function getPlatformAssistantId(): string {
  return str("PLATFORM_ASSISTANT_ID") ?? _platformAssistantIdOverride ?? "";
}

/**
 * PLATFORM_INTERNAL_API_KEY — static internal gateway key for authenticating
 * with the platform's internal gateway callback route registration endpoint.
 */
export function getPlatformInternalApiKey(): string {
  return str("PLATFORM_INTERNAL_API_KEY") ?? "";
}

// ── Telemetry ──────────────────────────────────────────────────────────────────

export function getTelemetryPlatformUrl(): string {
  return str("TELEMETRY_PLATFORM_URL") ?? "https://platform.vellum.ai";
}

export function getTelemetryAppToken(): string {
  return (
    str("TELEMETRY_APP_TOKEN") ??
    "e01cf85768cc3617e986f0a7f1966b72e25316526c5db54c8b94a9c3c5c9eaed"
  );
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
  if (httpPort < 1 || httpPort > 65535) {
    throw new Error(`Invalid RUNTIME_HTTP_PORT: ${httpPort} (must be 1-65535)`);
  }

  for (const warning of checkUnrecognizedEnvVars()) {
    log.warn(warning);
  }
}
