import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";

/**
 * `emergency-fable-reroute` — emergency kill-switch that reroutes Claude Fable
 * invocations to Claude Opus 4.8. Declared in
 * `meta/feature-flags/feature-flag-registry.json` and provisioned in
 * LaunchDarkly via the vellum-assistant-platform Terraform config; targeting is
 * controlled from the LaunchDarkly dashboard.
 */
const EMERGENCY_FABLE_REROUTE_FLAG = "emergency-fable-reroute" as const;

/** Anthropic-native model id rerouted away from when the flag is enabled. */
const FABLE_MODEL_ID = "claude-fable-5";

/** Model id the reroute targets. */
const FABLE_REROUTE_TARGET_MODEL_ID = "claude-opus-4-8";

export function isEmergencyFableRerouteEnabled(
  config: AssistantConfig,
): boolean {
  return isAssistantFeatureFlagEnabled(EMERGENCY_FABLE_REROUTE_FLAG, config);
}

/**
 * Returns the model id to invoke. When the emergency reroute flag is enabled,
 * Claude Fable (`claude-fable-5`) is swapped for Claude Opus 4.8
 * (`claude-opus-4-8`); every other model id is returned unchanged.
 *
 * Scoped to the Anthropic-native `claude-fable-5` id only: the OpenRouter
 * `anthropic/claude-fable-5` id has no Opus 4.8 equivalent on that provider, so
 * rerouting it would point at a non-existent model.
 */
export function applyEmergencyFableReroute(
  model: string,
  config: AssistantConfig,
): string {
  if (model === FABLE_MODEL_ID && isEmergencyFableRerouteEnabled(config)) {
    return FABLE_REROUTE_TARGET_MODEL_ID;
  }
  return model;
}
