import { resolveModelIntent } from "../providers/model-intents.js";
import type { ModelIntent } from "../providers/types.js";
import { loadRawConfig, saveRawConfig } from "./loader.js";
import {
  DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
  type ProfileEntry,
} from "./schemas/llm.js";

/**
 * Provider connection backing every managed profile. Seeded by
 * `seedCanonicalConnections` in `providers/inference/connections.ts`; auth is
 * `{ type: "platform" }` so dispatch resolves credentials from the logged-in
 * Vellum account at call time. Users who want to use OpenAI / Gemini / a local
 * model create their own connection + profile through the Providers UI; the
 * daemon never auto-materializes a custom profile here.
 */
const MANAGED_CONNECTION_NAME = "anthropic-managed";
const MANAGED_PROFILE_PROVIDER: NonNullable<ProfileEntry["provider"]> =
  "anthropic";

/**
 * Template for a daemon-managed inference profile. The profile's model is
 * resolved at seed time from `PROVIDER_MODEL_INTENTS` so the catalog stays the
 * single source of truth for "which model does this intent map to?".
 */
type ManagedProfileTemplate = Omit<ProfileEntry, "provider" | "model"> & {
  intent: ModelIntent;
};

/**
 * Anthropic-managed profiles. Always seeded so users can target Anthropic via
 * their own key, even when the resolved default provider is something else.
 */
const ANTHROPIC_PROFILE_TEMPLATES: Record<string, ManagedProfileTemplate> = {
  balanced: {
    intent: "balanced",
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
    source: "managed",
    label: "Quality",
    description: "Best results with the most capable model",
    maxTokens: 32000,
    effort: "max",
    thinking: { enabled: true, streamThinking: true },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
  "cost-optimized": {
    intent: "latency-optimized",
    source: "managed",
    label: "Speed",
    description: "Fastest responses at lower cost",
    maxTokens: 8192,
    effort: "low",
    thinking: { enabled: false, streamThinking: false },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
};

export const MANAGED_PROFILE_NAMES = new Set(
  Object.keys(ANTHROPIC_PROFILE_TEMPLATES),
);

export type SeedInferenceProfilesOptions = {
  /**
   * Managed profile names supplied by the platform/default overlay for this
   * startup. Those entries are already on disk by the time seeding runs and
   * should remain authoritative for this boot.
   */
  preserveProfileNames?: Iterable<string>;
  preserveActiveProfile?: boolean;
};

/**
 * Seed managed inference profiles into the workspace config.
 *
 * Called on every daemon startup after workspace migrations and default-config
 * overlay merge, but before the first `loadConfig()`. The 3 Anthropic-managed
 * profiles (`balanced`, `quality-optimized`, `cost-optimized`) are always
 * written so users can target Anthropic via their own key. When the resolved
 * default provider is non-Anthropic, the 3 `custom-*` profiles are also
 * materialized using `resolveModelIntent` against that provider, and
 * `custom-balanced` becomes the active profile for fresh hatches.
 *
 * Default-config overlays can provide their own profile fragments and active
 * profile. Lifecycle passes those explicit fields in `options`, letting local
 * hatches still receive managed defaults while platform-owned profile choices
 * remain authoritative.
 */
export function seedInferenceProfiles(
  options: SeedInferenceProfilesOptions = {},
): void {
  const config = loadRawConfig();
  const preservedProfileNames = new Set(options.preserveProfileNames ?? []);

  if (config.llm == null || typeof config.llm !== "object") {
    config.llm = {};
  }
  const llm = config.llm as Record<string, unknown>;

  if (llm.profiles == null || typeof llm.profiles !== "object") {
    llm.profiles = {};
  }
  const profiles = llm.profiles as Record<string, Record<string, unknown>>;

  // Seed the 3 managed profiles at their canonical names on fresh installs.
  // Each points at the `anthropic-managed` provider connection (seeded by
  // `seedCanonicalConnections`). We never overwrite an existing on-disk
  // entry: platform overlays (covered by `preserveProfileNames`) and user
  // edits via the Providers UI both stay authoritative across boots. The
  // daemon's job here is only to ensure the canonical names exist for a
  // fresh hatch.
  for (const [name, template] of Object.entries(ANTHROPIC_PROFILE_TEMPLATES)) {
    if (preservedProfileNames.has(name)) continue;
    if (readObject(profiles[name]) !== null) continue;
    profiles[name] = materializeProfile(template);
  }

  const requestedActiveProfile = readString(llm.activeProfile);
  const requestedActiveExists =
    requestedActiveProfile !== undefined &&
    readObject(profiles[requestedActiveProfile]) !== null;
  const shouldPreserveActiveProfile =
    options.preserveActiveProfile === true && requestedActiveExists;

  // Active profile resolution: an existing valid choice wins. Otherwise fall
  // back to the managed "balanced" default. User profiles created through
  // the Providers UI keep their own activeProfile selection — we only
  // reassign when the requested profile doesn't exist.
  if (!shouldPreserveActiveProfile && !requestedActiveExists) {
    llm.activeProfile = "balanced";
  }

  const profileOrder = Array.isArray(llm.profileOrder)
    ? (llm.profileOrder as string[])
    : [];
  const orderSet = new Set(profileOrder);
  for (const name of Object.keys(ANTHROPIC_PROFILE_TEMPLATES)) {
    if (!orderSet.has(name)) {
      profileOrder.push(name);
      orderSet.add(name);
    }
  }
  llm.profileOrder = profileOrder;

  for (const [name, profile] of Object.entries(profiles)) {
    if (MANAGED_PROFILE_NAMES.has(name)) continue;
    if (
      profile != null &&
      typeof profile === "object" &&
      !("source" in profile)
    ) {
      profile.source = "user";
    }
  }

  saveRawConfig(config);
}

function materializeProfile(template: ManagedProfileTemplate): ProfileEntry {
  const { intent, ...rest } = template;
  return {
    ...rest,
    provider: MANAGED_PROFILE_PROVIDER,
    provider_connection: MANAGED_CONNECTION_NAME,
    model: resolveModelIntent(MANAGED_PROFILE_PROVIDER, intent),
  };
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
