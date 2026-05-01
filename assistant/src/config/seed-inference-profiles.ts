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
export const MANAGED_PROFILE_SEED_DATA: Record<string, ProfileEntry> = {
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

/**
 * Seed managed inference profiles into the workspace config.
 *
 * Called on every daemon startup after workspace migrations and before
 * the first `loadConfig()`. Managed profiles are overwritten entirely
 * (replace, not merge) so upstream model/effort changes propagate.
 * User-created profiles are never touched; pre-existing profiles
 * without a `source` field get `source: "user"` backfilled.
 *
 * No-op when `VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH` is set (same guard
 * as migration 052) because the platform-provided default-config overlay
 * is the authoritative source for profile seeds.
 */
export function seedInferenceProfiles(): void {
  if (process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH) return;

  const config = loadRawConfig();

  if (config.llm == null || typeof config.llm !== "object") {
    config.llm = {};
  }
  const llm = config.llm as Record<string, unknown>;

  if (llm.profiles == null || typeof llm.profiles !== "object") {
    llm.profiles = {};
  }
  const profiles = llm.profiles as Record<string, Record<string, unknown>>;

  for (const [name, seed] of Object.entries(MANAGED_PROFILE_SEED_DATA)) {
    profiles[name] = { ...seed };
  }

  // Reset to "balanced" when the current value references a missing profile
  if (
    typeof llm.activeProfile !== "string" ||
    !(llm.activeProfile in profiles)
  ) {
    llm.activeProfile = "balanced";
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
