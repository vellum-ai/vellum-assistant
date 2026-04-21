/**
 * Gateway-backed auto-approve threshold reader.
 *
 * When the `auto-approve-threshold-ui` feature flag is enabled, reads
 * thresholds from the gateway REST API. Falls back to `undefined` (caller
 * uses config-based `resolveThreshold`) when the flag is off or the gateway
 * is unreachable.
 */

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import {
  gatewayGet,
  GatewayRequestError,
} from "../runtime/gateway-internal-client.js";
import { getLogger } from "../util/logger.js";
import type { ExecutionContext } from "./approval-policy.js";

const log = getLogger("gateway-threshold-reader");

// ── Types ────────────────────────────────────────────────────────────────────

type Threshold = "none" | "low" | "medium";

interface GlobalThresholds {
  interactive: string;
  background: string;
  headless: string;
}

interface ConversationThreshold {
  threshold: string;
}

// ── Global threshold cache (30s TTL) ─────────────────────────────────────────

let cachedGlobalThresholds: GlobalThresholds | null = null;
let cachedGlobalTimestamp = 0;
const GLOBAL_CACHE_TTL_MS = 30_000;

/**
 * Clear the global threshold cache. Exported for testing.
 */
export function _clearGlobalCacheForTesting(): void {
  cachedGlobalThresholds = null;
  cachedGlobalTimestamp = 0;
}

// ── Hardcoded fallback defaults ──────────────────────────────────────────────

const HARDCODED_DEFAULTS: Record<ExecutionContext, Threshold> = {
  conversation: "low",
  background: "medium",
  headless: "none",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function mapExecutionContextToField(
  executionContext: ExecutionContext,
): keyof GlobalThresholds {
  if (executionContext === "conversation") return "interactive";
  return executionContext;
}

function isValidThreshold(value: string): value is Threshold {
  return value === "none" || value === "low" || value === "medium";
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Read the auto-approve threshold from the gateway.
 *
 * Returns `undefined` when the feature flag is off (caller falls back to
 * config-based `resolveThreshold`).
 *
 * For `"conversation"` context with a `conversationId`, checks for a
 * per-conversation override first. Falls through to global defaults when
 * the conversation override returns 404 or is absent.
 *
 * Caches global thresholds for 30 seconds to avoid hammering the gateway.
 * On any gateway error (other than 404 for conversation override), logs a
 * warning and returns hardcoded defaults.
 */
export async function getAutoApproveThreshold(
  conversationId: string | undefined,
  executionContext?: ExecutionContext,
): Promise<Threshold | undefined> {
  const config = getConfig();
  if (!isAssistantFeatureFlagEnabled("auto-approve-threshold-ui", config)) {
    return undefined;
  }

  const ctx: ExecutionContext = executionContext ?? "conversation";

  // For conversation context with a conversationId, try per-conversation override first
  if (ctx === "conversation" && conversationId) {
    try {
      const result = await gatewayGet<ConversationThreshold>(
        `/v1/permissions/thresholds/conversations/${conversationId}`,
      );
      if (isValidThreshold(result.threshold)) {
        return result.threshold;
      }
    } catch (err) {
      if (err instanceof GatewayRequestError && err.statusCode === 404) {
        // No conversation override — fall through to global
      } else {
        log.warn(
          { conversationId, error: String(err) },
          "Failed to fetch conversation threshold override, falling back to defaults",
        );
        return HARDCODED_DEFAULTS[ctx];
      }
    }
  }

  // Fetch global thresholds (with 30s cache)
  try {
    const global = await fetchGlobalThresholds();
    const field = mapExecutionContextToField(ctx);
    const value = global[field];
    if (isValidThreshold(value)) {
      return value;
    }
    // Unexpected value from gateway — fall back to hardcoded
    log.warn({ field, value }, "Gateway returned unexpected threshold value");
    return HARDCODED_DEFAULTS[ctx];
  } catch (err) {
    log.warn(
      { error: String(err) },
      "Failed to fetch global thresholds, falling back to defaults",
    );
    return HARDCODED_DEFAULTS[ctx];
  }
}

async function fetchGlobalThresholds(): Promise<GlobalThresholds> {
  const now = Date.now();
  if (
    cachedGlobalThresholds &&
    now - cachedGlobalTimestamp < GLOBAL_CACHE_TTL_MS
  ) {
    return cachedGlobalThresholds;
  }

  const result = await gatewayGet<GlobalThresholds>(
    "/v1/permissions/thresholds",
  );
  cachedGlobalThresholds = result;
  cachedGlobalTimestamp = Date.now();
  return result;
}
