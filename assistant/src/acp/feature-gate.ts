/**
 * ACP (Agent Client Protocol) feature gate.
 *
 * Single source of truth for whether the ACP subsystem is enabled. Modeled
 * on `credential-execution/feature-gates.ts`: the flag key is declared in
 * `meta/feature-flags/feature-flag-registry.json` and resolved through the
 * unified feature-flag resolver.
 *
 * The gate is an OR of two independent switches:
 *   1. `config.acp.enabled` — the original workspace config field. Preserved
 *      so existing workspaces with `acp.enabled: true` keep working without
 *      any migration.
 *   2. The `acp` feature flag — adds a UI toggle. Flag state is persisted by
 *      the gateway and hot-refreshed in the daemon via the
 *      `feature_flags_changed` SSE event, so toggling it takes effect
 *      without a restart or config-file edit.
 */

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";

/** Gate for the ACP coding-agent subsystem (must match the registry). */
export const ACP_FLAG_KEY = "acp" as const;

/**
 * Whether ACP agent spawning/steering is enabled, via either the legacy
 * `acp.enabled` config field or the `acp` feature flag (see module doc).
 */
export function isAcpEnabled(config: AssistantConfig): boolean {
  return (
    config.acp.enabled || isAssistantFeatureFlagEnabled(ACP_FLAG_KEY, config)
  );
}
