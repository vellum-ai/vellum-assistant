import type { DrizzleDb } from "../memory/db-connection.js";
import {
  createConnection,
  getConnection,
  MANAGED_CONNECTION_NAMES,
  PROVIDERS_REQUIRING_BASE_URL_AND_MODELS,
} from "../providers/inference/connections.js";
import { PROVIDER_CATALOG } from "../providers/model-catalog.js";
import { credentialKey } from "../security/credential-key.js";
import { getLogger } from "../util/logger.js";
import {
  AUTO_PROFILE_KEY,
  type BuiltinProfileDefinition,
  MANAGED_PROFILE_NAMES,
  MANAGED_PROFILE_TEMPLATES,
  materializeProfile,
} from "./builtin-inference-profiles.js";
import { loadRawConfig, saveRawConfig } from "./loader.js";
import {
  DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
  type ProfileEntry,
} from "./schemas/llm.js";

// Re-exported so existing importers of the seeder keep working; the canonical
// home for built-in profile definitions is `builtin-inference-profiles.ts`.
export { AUTO_PROFILE_KEY, MANAGED_PROFILE_NAMES };

const log = getLogger("seed-inference-profiles");

/**
 * User profile templates. Materialized at hatch time for off-platform
 * installations. Each points at the user's personal provider connection
 * (backed by their API key in CES). The `provider` and `connectionName`
 * fields are placeholders — they are overridden at hatch time with the
 * user's chosen provider and personal connection name.
 */
const USER_PROFILE_TEMPLATES: Record<string, BuiltinProfileDefinition> = {
  "custom-balanced": {
    intent: "balanced",
    provider: "anthropic",
    connectionName: "",
    source: "user",
    label: "Balanced",
    description: "Good balance of quality, cost, and speed",
    maxTokens: 16000,
    effort: "high",
    thinking: { enabled: true, streamThinking: true },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
  "custom-quality-optimized": {
    intent: "quality-optimized",
    provider: "anthropic",
    connectionName: "",
    source: "user",
    label: "Quality",
    description: "Best results with the most capable model",
    maxTokens: 32000,
    effort: "high",
    thinking: { enabled: true, streamThinking: true },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
  "custom-cost-optimized": {
    intent: "latency-optimized",
    provider: "anthropic",
    connectionName: "",
    source: "user",
    label: "Speed",
    description: "Fastest responses at lower cost",
    maxTokens: 8192,
    effort: "low",
    thinking: { enabled: false, streamThinking: false },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
};

export type SeedInferenceProfilesOptions = {
  /**
   * Custom profile names supplied by the platform/default overlay for this
   * startup. Those entries are already on disk and should remain
   * authoritative. Built-in names never appear here —
   * `mergeDefaultWorkspaceConfig` converts overlay built-in entries to
   * `llm.profileOverrides` before seeding runs.
   */
  preserveProfileNames?: Iterable<string>;
  preserveActiveProfile?: boolean;
  /** True when a hatch overlay was consumed this startup. */
  isHatch?: boolean;
  /** DB handle for creating user provider connections at hatch time. */
  db?: DrizzleDb;
};

/**
 * Seed inference profiles into the workspace config.
 *
 * Runs on every daemon startup. Built-in (managed + auto) profiles are
 * code-resolved at config load time (`applyBuiltinProfiles` in `loader.ts`)
 * and never written to `config.json` — the only persisted built-in state is
 * the sparse `llm.profileOverrides` store. The seeder's responsibilities:
 *
 * 1. **User profiles** (`custom-balanced`, `custom-quality-optimized`,
 *    `custom-cost-optimized`): materialized once at hatch time for
 *    off-platform installations. Each points at a personal provider
 *    connection backed by the user's API key in CES. Subsequent boots
 *    leave these untouched — the user owns them.
 *
 * 2. **BYOK hatch status overrides**: a fresh off-platform hatch writes
 *    `status: "disabled"` overrides for built-ins whose managed connection
 *    isn't the hatch-selected one, so the picker doesn't offer unusable
 *    platform-auth options on day one.
 *
 * 3. **activeProfile defaults** and source-tagging of custom profiles.
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

  const isPlatform =
    process.env.IS_PLATFORM === "true" || process.env.IS_PLATFORM === "1";

  // BYOK mode = off-platform installs (the user brings their own provider
  // API key).
  const isByokMode = !isPlatform;

  // 1. BYOK hatch status overrides. A fresh BYOK hatch has no platform auth,
  //    so built-ins whose managed connection isn't the hatch-selected one
  //    must not surface as enabled in the picker on day one. The disable is
  //    persisted as a sparse `llm.profileOverrides` status entry; a
  //    pre-existing status override key (e.g. from a prior hatch or a user
  //    toggle) is never clobbered. Applied to every definition regardless of
  //    feature-flag state — an override for a flag-off profile is harmless
  //    and correct if the flag later enables.
  if (options.isHatch && isByokMode) {
    const hatchSelectedManagedConnection = getHatchSelectedManagedConnection(
      llm,
      profiles,
      options,
    );
    let profileOverrides = readObject(llm.profileOverrides);
    if (!profileOverrides) {
      profileOverrides = {};
      llm.profileOverrides = profileOverrides;
    }
    for (const [name, template] of Object.entries(MANAGED_PROFILE_TEMPLATES)) {
      if (template.connectionName === hatchSelectedManagedConnection) continue;
      const existing = readObject(profileOverrides[name]);
      if (existing && "status" in existing) continue;
      profileOverrides[name] = { ...existing, status: "disabled" };
    }
  }

  // 2. User profiles — only at hatch time for off-platform installations.
  let userConnectionName: string | undefined;
  if (options.isHatch && !isPlatform) {
    const hatchProvider = readString(readObject(llm.default)?.provider);
    if (
      hatchProvider &&
      hatchProvider !== "ollama" &&
      !PROVIDERS_REQUIRING_BASE_URL_AND_MODELS.has(hatchProvider)
    ) {
      userConnectionName = `${hatchProvider}-personal`;

      if (options.db) {
        if (!getConnection(options.db, userConnectionName)) {
          const credName = credentialKey(hatchProvider, "api_key");
          const result = createConnection(options.db, {
            name: userConnectionName,
            provider: hatchProvider,
            auth: { type: "api_key", credential: credName },
            label: personalConnectionLabel(hatchProvider),
          });
          if (!result.ok) {
            log.warn(
              { provider: hatchProvider, error: result.error },
              "Failed to create personal connection during hatch seeding",
            );
          }
        }
      }

      const provider = hatchProvider as NonNullable<ProfileEntry["provider"]>;
      for (const [name, template] of Object.entries(USER_PROFILE_TEMPLATES)) {
        if (preservedProfileNames.has(name)) continue;
        profiles[name] = materializeProfile(
          template,
          provider,
          userConnectionName,
        );
      }
    }
  }

  // Active profile resolution. Built-in names count as present even though
  // they are never materialized into `profiles` — the loader resolves them
  // from code at every read.
  const requestedActiveProfile = readString(llm.activeProfile);
  const requestedActiveExists =
    requestedActiveProfile !== undefined &&
    (MANAGED_PROFILE_NAMES.has(requestedActiveProfile) ||
      readObject(profiles[requestedActiveProfile]) !== null);
  const shouldPreserveActiveProfile =
    options.preserveActiveProfile === true && requestedActiveExists;

  if (!shouldPreserveActiveProfile) {
    if (options.isHatch) {
      // Hatch = fresh setup. Pick the right default based on platform mode.
      llm.activeProfile = userConnectionName ? "custom-balanced" : "balanced";
    } else if (!requestedActiveExists) {
      llm.activeProfile = "balanced";
    }
  }

  // Profile ordering — ensure hatch-seeded custom profiles appear in the
  // order array. Built-in names are spliced into the in-memory order by the
  // config loader, never persisted here.
  if (userConnectionName) {
    const profileOrder = Array.isArray(llm.profileOrder)
      ? (llm.profileOrder as string[])
      : [];
    const orderSet = new Set(profileOrder);
    for (const name of Object.keys(USER_PROFILE_TEMPLATES)) {
      if (!orderSet.has(name)) {
        profileOrder.push(name);
        orderSet.add(name);
      }
    }
    llm.profileOrder = profileOrder;
  }

  // Tag any remaining profiles without a source as user-created.
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

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getHatchSelectedManagedConnection(
  llm: Record<string, unknown>,
  profiles: Record<string, Record<string, unknown>>,
  options: SeedInferenceProfilesOptions,
): string | undefined {
  if (!options.isHatch || options.preserveActiveProfile !== true) {
    return undefined;
  }

  const activeProfile = readString(llm.activeProfile);
  if (!activeProfile) return undefined;

  // Built-in active profiles resolve their connection from the code
  // template — built-ins are never materialized into `profiles`, and the
  // template is authoritative for connection routing.
  const templateConnection =
    MANAGED_PROFILE_TEMPLATES[activeProfile]?.connectionName;
  if (templateConnection) {
    return MANAGED_CONNECTION_NAMES.has(templateConnection)
      ? templateConnection
      : undefined;
  }

  const activeProfileEntry = readObject(profiles[activeProfile]);
  const explicitConnection = activeProfileEntry
    ? readString(activeProfileEntry.provider_connection)
    : undefined;
  return explicitConnection && MANAGED_CONNECTION_NAMES.has(explicitConnection)
    ? explicitConnection
    : undefined;
}

/**
 * Format the human-readable label seeded onto a personal provider connection
 * at hatch time, e.g. `"Anthropic (Personal)"`. The display name is sourced
 * from `PROVIDER_CATALOG` so it tracks the canonical provider directory; an
 * unrecognised provider id falls back to the raw id with the suffix.
 */
function personalConnectionLabel(providerId: string): string {
  const displayName =
    PROVIDER_CATALOG.find((p) => p.id === providerId)?.displayName ??
    providerId;
  return `${displayName} (Personal)`;
}
