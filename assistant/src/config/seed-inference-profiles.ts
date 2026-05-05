import { loadRawConfig, saveRawConfig } from "./loader.js";
import {
  DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
  type ProfileEntry,
} from "./schemas/llm.js";

/**
 * Declarative seed data for daemon-managed inference profiles.
 *
 * These profiles are overwritten on every startup so upstream model
 * updates propagate automatically. User-created profiles (keyed by
 * different names) are never touched.
 */
const MANAGED_PROFILE_SEED_DATA: Record<string, ProfileEntry> = {
  balanced: {
    source: "managed",
    label: "Balanced",
    description: "Good balance of quality, cost, and speed",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    maxTokens: 16000,
    effort: "high",
    thinking: { enabled: true, streamThinking: true },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
  "quality-optimized": {
    source: "managed",
    label: "Quality",
    description: "Best results with the most capable model",
    provider: "anthropic",
    model: "claude-opus-4-7",
    maxTokens: 32000,
    effort: "max",
    thinking: { enabled: true, streamThinking: true },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
  "cost-optimized": {
    source: "managed",
    label: "Speed",
    description: "Fastest responses at lower cost",
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    maxTokens: 8192,
    effort: "low",
    thinking: { enabled: false, streamThinking: false },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
};

export const MANAGED_PROFILE_NAMES = new Set(
  Object.keys(MANAGED_PROFILE_SEED_DATA),
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
 * overlays merge, but before the first `loadConfig()`. Managed profiles are
 * overwritten entirely (replace, not merge) so upstream model/effort changes
 * propagate. User-created profiles are never touched; pre-existing profiles
 * without a `source` field get `source: "user"` backfilled.
 *
 * Default-config overlays can provide their own profile fragments and active
 * profile. Lifecycle passes those explicit fields in `options`, letting local
 * hatches still receive managed Anthropic defaults while platform-owned
 * profile choices remain authoritative.
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
  const isAnthropicDefault =
    resolveEffectiveDefaultProvider(llm) === "anthropic";

  for (const [name, seed] of Object.entries(MANAGED_PROFILE_SEED_DATA)) {
    if (
      preservedProfileNames.has(name) &&
      readObject(profiles[name]) !== null
    ) {
      continue;
    }
    profiles[name] = isAnthropicDefault ? { ...seed } : {};
  }

  const activeProfile = readString(llm.activeProfile);
  const activeProfileExists =
    activeProfile !== undefined && readObject(profiles[activeProfile]) !== null;
  const shouldPreserveActiveProfile =
    options.preserveActiveProfile && activeProfileExists;

  if (isAnthropicDefault) {
    // Reset to the default managed profile when the current value is missing.
    if (!activeProfileExists) {
      llm.activeProfile = "balanced";
    }
  } else if (
    !shouldPreserveActiveProfile &&
    (activeProfile === undefined ||
      !activeProfileExists ||
      MANAGED_PROFILE_NAMES.has(activeProfile))
  ) {
    delete llm.activeProfile;
  }

  const profileOrder = Array.isArray(llm.profileOrder)
    ? (llm.profileOrder as string[])
    : [];
  const orderSet = new Set(profileOrder);
  for (const name of MANAGED_PROFILE_NAMES) {
    if (!orderSet.has(name)) {
      profileOrder.push(name);
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

function resolveEffectiveDefaultProvider(llm: Record<string, unknown>): string {
  return readString(readObject(llm.default)?.provider) ?? "anthropic";
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
