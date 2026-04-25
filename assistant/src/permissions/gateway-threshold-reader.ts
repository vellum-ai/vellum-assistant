/**
 * Gateway-backed auto-approve threshold reader.
 *
 * Reads thresholds from the gateway via IPC. Returns undefined when the
 * gateway is unreachable so callers fall back to local config thresholds.
 */

import { ipcCall } from "../ipc/gateway-client.js";
import { getLogger } from "../util/logger.js";
import type { ExecutionContext } from "./approval-policy.js";

const log = getLogger("gateway-threshold-reader");

// ── Types ────────────────────────────────────────────────────────────────────

type Threshold = "none" | "low" | "medium" | "high";

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

// ── Conversation threshold cache (5s TTL) ────────────────────────────────────
// Shorter TTL than global because the user can change mid-conversation via the
// picker UI, but still avoids a network roundtrip on every single tool call
// within a burst.

const conversationThresholdCache = new Map<
  string,
  { threshold: string | null; timestamp: number }
>();
const CONVERSATION_CACHE_TTL_MS = 5_000;

/**
 * Clear the global threshold cache. Exported for testing.
 */
export function _clearGlobalCacheForTesting(): void {
  cachedGlobalThresholds = null;
  cachedGlobalTimestamp = 0;
  conversationThresholdCache.clear();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function mapExecutionContextToField(
  executionContext: ExecutionContext,
): keyof GlobalThresholds {
  if (executionContext === "conversation") return "interactive";
  return executionContext;
}

function isValidThreshold(value: string): value is Threshold {
  return (
    value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
  );
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Read the auto-approve threshold from the gateway via IPC.
 *
 * For `"conversation"` context with a `conversationId`, checks for a
 * per-conversation override first. Falls through to global defaults when
 * the conversation override is absent.
 *
 * Caches global thresholds for 30 seconds to avoid hammering the gateway.
 * On any IPC error, logs a warning and returns undefined.
 */
export async function getAutoApproveThreshold(
  conversationId: string | undefined,
  executionContext?: ExecutionContext,
): Promise<Threshold | undefined> {
  const ctx: ExecutionContext = executionContext ?? "conversation";

  // For conversation context with a conversationId, try per-conversation override first
  if (ctx === "conversation" && conversationId) {
    // Check cache first (5s TTL) — includes negative entries (no override)
    const cached = conversationThresholdCache.get(conversationId);
    if (cached && Date.now() - cached.timestamp < CONVERSATION_CACHE_TTL_MS) {
      if (cached.threshold === null) {
        // Negative cache hit — no override exists, fall through to global
      } else if (isValidThreshold(cached.threshold)) {
        return cached.threshold;
      }
    } else {
      // ipcCall() returns undefined on transport failure (socket not found,
      // timeout, etc.) and null when the gateway explicitly says "no override".
      // On transport failure, fall through to the global threshold without
      // poisoning the cache — a transient IPC failure must not cause subsequent
      // approval checks to skip a real override for up to 5 seconds.
      const result = (await ipcCall("get_conversation_threshold", {
        conversationId,
      })) as ConversationThreshold | null | undefined;

      if (result === undefined) {
        log.warn(
          { conversationId },
          "IPC call failed for conversation threshold override, falling through to global",
        );
        // Fall through to global threshold fetch below.
      } else if (result && isValidThreshold(result.threshold)) {
        conversationThresholdCache.set(conversationId, {
          threshold: result.threshold,
          timestamp: Date.now(),
        });
        return result.threshold;
      } else {
        // result === null (or an unexpected shape) — cache the negative result
        // and fall through to global defaults.
        conversationThresholdCache.set(conversationId, {
          threshold: null,
          timestamp: Date.now(),
        });
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
    // Unexpected value from gateway — return undefined so checker falls back
    // to the local config threshold (isGatewayThreshold stays false).
    log.warn({ field, value }, "Gateway returned unexpected threshold value");
    return undefined;
  } catch (err) {
    // Gateway unreachable — return undefined so checker.ts falls back to
    // resolveThreshold(config.permissions.autoApproveUpTo). This preserves
    // isGatewayThreshold = false, keeping ask-rule overrides inactive when
    // the gateway is down.
    log.warn(
      { error: String(err) },
      "Failed to fetch global thresholds, falling back to local config",
    );
    return undefined;
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

  const result = (await ipcCall(
    "get_global_thresholds",
  )) as GlobalThresholds | null;

  if (!result) {
    throw new Error("Gateway IPC returned no result for global thresholds");
  }

  cachedGlobalThresholds = result;
  cachedGlobalTimestamp = Date.now();
  return result;
}
