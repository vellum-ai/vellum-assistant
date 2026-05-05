import {
  isModelInCatalog,
  PROVIDER_CATALOG,
} from "../providers/model-catalog.js";
import { resolveModelIntent } from "../providers/model-intents.js";
import type { ModelIntent } from "../providers/types.js";
import { loadRawConfig, saveRawConfig } from "./loader.js";
import {
  DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
  type ProfileEntry,
} from "./schemas/llm.js";

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

/**
 * Custom-provider profile templates. Materialized at seed time when the
 * resolved default provider is non-Anthropic, using `resolveModelIntent` to
 * pick the model.
 */
const CUSTOM_PROFILE_TEMPLATES: Record<string, ManagedProfileTemplate> = {
  "custom-balanced": {
    intent: "balanced",
    source: "managed",
    label: "Balanced (Custom Provider)",
    description: "Good balance of quality, cost, and speed",
    maxTokens: 16000,
    effort: "high",
    thinking: { enabled: true, streamThinking: true },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
  "custom-quality-optimized": {
    intent: "quality-optimized",
    source: "managed",
    label: "Quality (Custom Provider)",
    description: "Best results with the most capable model",
    maxTokens: 32000,
    effort: "max",
    thinking: { enabled: true, streamThinking: true },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
  "custom-cost-optimized": {
    intent: "latency-optimized",
    source: "managed",
    label: "Speed (Custom Provider)",
    description: "Fastest responses at lower cost",
    maxTokens: 8192,
    effort: "low",
    thinking: { enabled: false, streamThinking: false },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
};

export const MANAGED_PROFILE_NAMES = new Set([
  ...Object.keys(ANTHROPIC_PROFILE_TEMPLATES),
  ...Object.keys(CUSTOM_PROFILE_TEMPLATES),
]);

const KNOWN_PROVIDERS = new Set(PROVIDER_CATALOG.map((entry) => entry.id));

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

  const requestedProvider =
    readString(readObject(llm.default)?.provider) ?? "anthropic";
  const resolvedProvider: NonNullable<ProfileEntry["provider"]> =
    KNOWN_PROVIDERS.has(requestedProvider)
      ? (requestedProvider as NonNullable<ProfileEntry["provider"]>)
      : "anthropic";
  const isAnthropicDefault = resolvedProvider === "anthropic";

  for (const [name, template] of Object.entries(ANTHROPIC_PROFILE_TEMPLATES)) {
    if (preservedProfileNames.has(name)) continue;
    // Preserve a previously overlay-supplied non-Anthropic version of an
    // Anthropic-managed name (e.g. platform-managed `balanced` with provider
    // `openai`). The overlay file is consumed and archived after first use,
    // so `preservedProfileNames` is only populated on the boot where the
    // overlay is merged — on subsequent boots the on-disk shape is the only
    // signal that the profile was platform-supplied.
    const existing = readObject(profiles[name]);
    const existingProvider = readString(existing?.provider);
    if (
      existing !== null &&
      existingProvider !== undefined &&
      existingProvider !== "anthropic"
    ) {
      continue;
    }
    profiles[name] = materializeProfile(template, "anthropic");
  }

  if (!isAnthropicDefault) {
    for (const [name, template] of Object.entries(CUSTOM_PROFILE_TEMPLATES)) {
      if (preservedProfileNames.has(name)) continue;
      profiles[name] = materializeProfile(template, resolvedProvider);
    }
  }

  const requestedActiveProfile = readString(llm.activeProfile);
  const requestedActiveEntry =
    requestedActiveProfile !== undefined
      ? readObject(profiles[requestedActiveProfile])
      : null;
  const requestedActiveExists = requestedActiveEntry !== null;
  const shouldPreserveActiveProfile =
    options.preserveActiveProfile === true && requestedActiveExists;

  // Decide whether the existing active profile is still appropriate. A managed
  // profile whose provider no longer matches the resolved default goes stale
  // (e.g. re-hatching anthropic→openai leaves `balanced` pointing at anthropic;
  // re-hatching openai→anthropic leaves `custom-balanced` pointing at openai).
  // Either direction should land the user on the new default's `balanced`
  // counterpart rather than routing the main agent to a stale provider.
  // User-created profiles are left alone — those are the user's choice.
  let keepActiveProfile = shouldPreserveActiveProfile;
  if (!keepActiveProfile && requestedActiveExists) {
    const isManagedName = MANAGED_PROFILE_NAMES.has(requestedActiveProfile!);
    const activeProvider = readString(requestedActiveEntry?.provider);
    const managedActiveProviderMismatch =
      isManagedName && activeProvider !== resolvedProvider;
    keepActiveProfile = !managedActiveProviderMismatch;
  }

  let activeProfileName: string;
  if (keepActiveProfile) {
    activeProfileName = requestedActiveProfile!;
  } else {
    activeProfileName = isAnthropicDefault ? "balanced" : "custom-balanced";
    llm.activeProfile = activeProfileName;
  }

  // Sync `llm.default.model` to the active profile's model so the providers
  // registry sees a coherent provider/model pair. Only writes when the on-disk
  // default model is missing or belongs to a different provider's catalog —
  // a user-supplied model that's valid for the resolved provider is preserved.
  // Skipped when the overlay owns the active profile (platform mode).
  if (!shouldPreserveActiveProfile) {
    const activeEntry = readObject(profiles[activeProfileName]);
    const activeModel = readString(activeEntry?.model);
    if (activeModel !== undefined) {
      const defaultBlock = (readObject(llm.default) ?? {}) as Record<
        string,
        unknown
      >;
      const currentModel = readString(defaultBlock.model);
      const currentModelMatchesProvider =
        currentModel !== undefined &&
        isModelInCatalog(resolvedProvider, currentModel);
      if (!currentModelMatchesProvider) {
        defaultBlock.model = activeModel;
        llm.default = defaultBlock;
      }
    }
  }

  const profileOrder = Array.isArray(llm.profileOrder)
    ? (llm.profileOrder as string[])
    : [];
  const orderSet = new Set(profileOrder);
  const seededOrder = [
    ...Object.keys(ANTHROPIC_PROFILE_TEMPLATES),
    ...(isAnthropicDefault ? [] : Object.keys(CUSTOM_PROFILE_TEMPLATES)),
  ];
  for (const name of seededOrder) {
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

function materializeProfile(
  template: ManagedProfileTemplate,
  provider: NonNullable<ProfileEntry["provider"]>,
): ProfileEntry {
  const { intent, ...rest } = template;
  return {
    ...rest,
    provider,
    model: resolveModelIntent(provider, intent),
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
