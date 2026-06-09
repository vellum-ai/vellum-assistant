import { resolveModelIntent } from "../providers/model-intents.js";
import type { ModelIntent } from "../providers/types.js";
import {
  DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
  type ProfileEntry,
  type ProfileStatus,
} from "./schemas/llm.js";

/**
 * Definition of a built-in (daemon-managed) inference profile. The profile's
 * model is resolved at materialization time from `PROVIDER_MODEL_INTENTS` so
 * the catalog stays the single source of truth for "which model does this
 * intent map to?".
 */
export type BuiltinProfileDefinition = Omit<
  ProfileEntry,
  "provider" | "model" | "provider_connection"
> & {
  intent: ModelIntent;
  provider: NonNullable<ProfileEntry["provider"]>;
  connectionName: string;
  /**
   * Optional feature-flag key gating this profile. When set and the flag
   * resolves disabled, the profile is omitted from the effective profile set
   * entirely (absent from both `profiles` and `order`).
   */
  featureFlag?: string;
};

/**
 * Managed profiles. Overwritten on every daemon boot so Vellum can push
 * model/config updates to customers in new releases. Platform overlays
 * (`preserveProfileNames`) take precedence when present.
 */
export const MANAGED_PROFILE_TEMPLATES: Record<
  string,
  BuiltinProfileDefinition
> = {
  balanced: {
    intent: "balanced",
    provider: "anthropic",
    connectionName: "anthropic-managed",
    source: "managed",
    label: "Balanced",
    description: "Good balance of quality, cost, and speed",
    maxTokens: 16000,
    effort: "high",
    thinking: { enabled: true, streamThinking: true },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
  "quality-optimized": {
    intent: "quality-optimized",
    provider: "anthropic",
    connectionName: "anthropic-managed",
    source: "managed",
    label: "Quality",
    description: "Best results with the most capable model",
    maxTokens: 32000,
    effort: "high",
    thinking: { enabled: true, streamThinking: true },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
  "cost-optimized": {
    intent: "latency-optimized",
    provider: "anthropic",
    connectionName: "anthropic-managed",
    source: "managed",
    label: "Speed",
    description: "Fastest responses at lower cost",
    maxTokens: 8192,
    effort: "low",
    thinking: { enabled: false, streamThinking: false },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
  // Open-weight economy option: Kimi K2.6 served by Fireworks via managed
  // platform inference. Carries the `suppress-cjk` logit-bias preset to
  // discourage the model from spontaneously emitting Chinese in English
  // output; the preset is profile-scoped and only forwarded on the Fireworks
  // path (see `providers/inference/logit-bias.ts`).
  "balanced-economy": {
    intent: "balanced",
    provider: "fireworks",
    connectionName: "fireworks-managed",
    source: "managed",
    label: "Balanced Economy",
    description: "Strong open model (Kimi K2.6) at a lower price point",
    maxTokens: 16000,
    effort: "high",
    thinking: { enabled: true, streamThinking: true },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
    logitBias: "suppress-cjk",
    featureFlag: "balanced-economy-profile",
  },
};

/**
 * The "auto" profile key. When active, the daemon injects the
 * `switch_inference_profile` tool and lets the model self-select a profile
 * per query. No provider/model — the resolver falls through to the call-site
 * default (balanced or custom-balanced for BYOK).
 */
export const AUTO_PROFILE_KEY = "auto";

export const MANAGED_PROFILE_NAMES = new Set([
  ...Object.keys(MANAGED_PROFILE_TEMPLATES),
  AUTO_PROFILE_KEY,
]);

export function materializeProfile(
  template: BuiltinProfileDefinition,
  provider: NonNullable<ProfileEntry["provider"]>,
  connectionName: string,
): ProfileEntry {
  const {
    intent,
    provider: _p,
    connectionName: _c,
    featureFlag: _f,
    ...rest
  } = template;
  return {
    ...rest,
    provider,
    provider_connection: connectionName,
    model: resolveModelIntent(provider, intent),
  };
}

/**
 * The `auto` profile entry is metadata-only: no provider/model — the resolver
 * falls through to the call-site default when it is active.
 */
export function createAutoProfileEntry(): ProfileEntry {
  return {
    source: "managed",
    label: "Auto",
    description:
      "Automatically routes each query to the best profile — fast for simple questions, capable for complex ones",
  };
}

/**
 * Sparse user override for a built-in profile. Only `label` and `status` are
 * user-ownable on built-ins; `null` means "explicitly cleared" and is applied
 * as-is (key-presence semantics — an absent key leaves the default in place).
 */
export type BuiltinProfileOverride = {
  label?: string | null;
  status?: ProfileStatus | null;
};

/**
 * Resolve the effective built-in profile set. Pure: reads only its arguments
 * and the module-level definitions — no config, env, or filesystem access.
 *
 * - Definitions whose `featureFlag` resolves disabled are omitted entirely.
 * - Off-platform (BYOK) installs get a `" (Managed)"` label suffix on managed
 *   profiles to disambiguate from the personal `custom-*` profiles that share
 *   base labels. The `auto` entry never gets the suffix.
 * - `overrides` are applied by key presence, so an explicit `null` (user
 *   cleared the value) is preserved.
 * - `order` lists `auto` first, then the flag-enabled managed profiles in
 *   definition order — matching the seeder's `profileOrder` maintenance.
 */
export function resolveBuiltinProfiles(opts: {
  isPlatform: boolean;
  isFlagEnabled: (key: string) => boolean;
  overrides: Record<string, BuiltinProfileOverride>;
}): { profiles: Record<string, ProfileEntry>; order: string[] } {
  const profiles: Record<string, ProfileEntry> = {};
  const order: string[] = [AUTO_PROFILE_KEY];

  const autoEntry = createAutoProfileEntry();
  applyOverride(autoEntry, opts.overrides[AUTO_PROFILE_KEY]);
  profiles[AUTO_PROFILE_KEY] = autoEntry;

  for (const [name, definition] of Object.entries(MANAGED_PROFILE_TEMPLATES)) {
    if (definition.featureFlag && !opts.isFlagEnabled(definition.featureFlag)) {
      continue;
    }
    const effective: BuiltinProfileDefinition = opts.isPlatform
      ? definition
      : { ...definition, label: `${definition.label} (Managed)` };
    const entry = materializeProfile(
      effective,
      definition.provider,
      definition.connectionName,
    );
    applyOverride(entry, opts.overrides[name]);
    profiles[name] = entry;
    order.push(name);
  }

  return { profiles, order };
}

function applyOverride(
  entry: ProfileEntry,
  override: BuiltinProfileOverride | undefined,
): void {
  if (!override) return;
  if ("label" in override) entry.label = override.label;
  if ("status" in override) entry.status = override.status;
}
