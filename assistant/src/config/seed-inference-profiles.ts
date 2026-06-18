import type { DrizzleDb } from "../memory/db-connection.js";
import {
  fetchManagedProfiles,
  type PlatformManagedProfile,
} from "../platform/managed-profiles.js";
import {
  createConnection,
  getConnection,
  PROVIDERS_REQUIRING_BASE_URL_AND_MODELS,
} from "../providers/inference/connections.js";
import { PROVIDER_CATALOG } from "../providers/model-catalog.js";
import { resolveModelIntent } from "../providers/model-intents.js";
import type { ModelIntent } from "../providers/types.js";
import { credentialKey } from "../security/credential-key.js";
import { getLogger } from "../util/logger.js";
import { loadRawConfig, saveRawConfig } from "./loader.js";
import {
  DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
  type ProfileEntry,
} from "./schemas/llm.js";

const log = getLogger("seed-inference-profiles");

/**
 * Template for a daemon-managed inference profile. The profile's model is
 * resolved at seed time from `PROVIDER_MODEL_INTENTS` so the catalog stays the
 * single source of truth for "which model does this intent map to?".
 */
type ManagedProfileTemplate = Omit<
  ProfileEntry,
  "provider" | "model" | "provider_connection"
> & {
  intent: ModelIntent;
  provider: NonNullable<ProfileEntry["provider"]>;
  connectionName: string;
};

/**
 * User profile templates. Materialized at hatch time for off-platform
 * installations. Each points at the user's personal provider connection
 * (backed by their API key in CES). The `provider` and `connectionName`
 * fields are placeholders — they are overridden at hatch time with the
 * user's chosen provider and personal connection name.
 */
const USER_PROFILE_TEMPLATES: Record<string, ManagedProfileTemplate> = {
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

/**
 * The "auto" profile key. When active, the daemon injects the
 * `switch_inference_profile` tool and lets the model self-select a profile
 * per query. No provider/model — the resolver falls through to the call-site
 * default (balanced or custom-balanced for BYOK).
 */
export const AUTO_PROFILE_KEY = "auto";

/** Stable keys of the platform-managed profiles. The profile *content* now
 *  comes from the platform model-profiles endpoint; only the key set lives
 *  in code, so route validation and pruning can recognise managed profiles. */
export const MANAGED_PROFILE_KEYS = [
  "balanced",
  "quality-optimized",
  "cost-optimized",
  "balanced-economy",
] as const;

export const MANAGED_PROFILE_NAMES = new Set<string>([
  ...MANAGED_PROFILE_KEYS,
  AUTO_PROFILE_KEY,
]);

export type SeedInferenceProfilesOptions = {
  /**
   * Profile names supplied by the platform/default overlay for this startup.
   * Those entries are already on disk and should remain authoritative.
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
 * Runs on every daemon startup. Two responsibilities:
 *
 * 1. **Managed profiles** (`balanced`, `quality-optimized`, `cost-optimized`,
 *    `balanced-economy`): fetched from the platform model-profiles endpoint and
 *    reconciled against the workspace config. The platform is authoritative:
 *      • Connected (`ok`): the fetched profiles replace the on-disk managed
 *        profiles verbatim (model resolved from intent client-side). Any
 *        managed key absent from the response is pruned. Only the user-owned
 *        `label` and `status` fields survive the reconcile.
 *      • No connection (`no-connection`): the install cannot use managed
 *        profiles, so all managed keys are pruned from disk.
 *      • Fetch error (`error`): managed profiles on disk are left untouched so
 *        a transient platform blip never wipes them.
 *
 * 2. **User profiles** (`custom-balanced`, `custom-quality-optimized`,
 *    `custom-cost-optimized`): materialized once at hatch time for
 *    off-platform installations. Each points at a personal provider
 *    connection backed by the user's API key in CES. Subsequent boots
 *    leave these untouched — the user owns them.
 */
export async function seedInferenceProfiles(
  options: SeedInferenceProfilesOptions = {},
): Promise<void> {
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

  // 1. Managed profiles. The platform model-profiles endpoint — not the
  //    workspace overlay — is the source of truth, so we reconcile against the
  //    fetch result rather than `preservedProfileNames`. Only the user-owned
  //    `label` and `status` fields survive a reconcile; everything else is
  //    platform-controlled and refreshed verbatim. Carry the overrides by
  //    key-presence (not truthiness) so an explicit `null` (user cleared the
  //    label) survives too.
  // Whenever a managed profile is pruned we must also scrub any call-site
  // `profile` pin that still points at it: `LLMSchema.superRefine` rejects a
  // call site referencing an undefined profile, and `loadConfig()` only strips
  // that in memory — the raw config on disk would stay invalid otherwise.
  const clearCallSiteProfileRefs = (prunedKeys: Set<string>): void => {
    if (prunedKeys.size === 0) return;
    const callSites = readObject(llm.callSites);
    if (!callSites) return;
    for (const entry of Object.values(callSites)) {
      const site = readObject(entry);
      if (!site) continue;
      const pinned = readString(site.profile);
      if (pinned !== undefined && prunedKeys.has(pinned)) {
        delete site.profile;
      }
    }
  };

  const managed = await fetchManagedProfiles();
  if (managed.status === "ok") {
    const fetchedKeys = new Set(managed.profiles.map((p) => p.key));
    for (const p of managed.profiles) {
      const previous = readObject(profiles[p.key]);
      const next = materializeManagedProfile(p);
      if (previous && "label" in previous) next.label = previous.label;
      if (previous && "status" in previous) next.status = previous.status;
      profiles[p.key] = next as ProfileEntry;
    }
    const prunedKeys = new Set<string>();
    for (const key of MANAGED_PROFILE_KEYS) {
      if (!fetchedKeys.has(key)) {
        delete profiles[key];
        prunedKeys.add(key);
      }
    }
    clearCallSiteProfileRefs(prunedKeys);
  } else if (managed.status === "no-connection") {
    const prunedKeys = new Set<string>();
    for (const key of MANAGED_PROFILE_KEYS) {
      delete profiles[key];
      prunedKeys.add(key);
    }
    clearCallSiteProfileRefs(prunedKeys);
  }
  // status === "error": leave on-disk managed profiles untouched.

  // 1b. Auto profile — a metadata-only profile with no provider/model. When
  //     the user selects "Auto", the resolver falls through to the call-site
  //     default (balanced or custom-balanced), and the agent loop injects the
  //     switch_inference_profile tool so the model can self-select per query.
  if (!preservedProfileNames.has(AUTO_PROFILE_KEY)) {
    const previousAuto = readObject(profiles[AUTO_PROFILE_KEY]);
    const autoEntry: Record<string, unknown> = {
      source: "managed",
      label: "Auto",
      description:
        "Automatically routes each query to the best profile — fast for simple questions, capable for complex ones",
    };
    if (previousAuto) {
      if ("label" in previousAuto) autoEntry.label = previousAuto.label;
      if ("status" in previousAuto) autoEntry.status = previousAuto.status;
    }
    profiles[AUTO_PROFILE_KEY] = autoEntry as ProfileEntry;
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

  // Active profile resolution.
  const requestedActiveProfile = readString(llm.activeProfile);
  const requestedActiveEntry =
    requestedActiveProfile !== undefined
      ? readObject(profiles[requestedActiveProfile])
      : null;
  const requestedActiveExists = requestedActiveEntry !== null;
  const shouldPreserveActiveProfile =
    options.preserveActiveProfile === true && requestedActiveExists;

  // Resolve a profile key to one that actually exists, falling back through
  // `custom-balanced → balanced → auto`. `auto` is always seeded, so this
  // always lands on a profile present in `profiles`.
  const resolveExistingProfile = (preferred: string): string => {
    if (preferred in profiles) return preferred;
    if ("custom-balanced" in profiles) return "custom-balanced";
    if ("balanced" in profiles) return "balanced";
    return AUTO_PROFILE_KEY;
  };

  if (!shouldPreserveActiveProfile) {
    if (options.isHatch) {
      // Hatch = fresh setup. Pick the right default based on platform mode,
      // then verify it survived the managed-profile prune. An off-platform
      // hatch without a user connection (e.g. ollama / openai-compatible)
      // would otherwise point at `balanced`, which is pruned when there is no
      // platform connection.
      const desired = userConnectionName ? "custom-balanced" : "balanced";
      llm.activeProfile = resolveExistingProfile(desired);
    } else if (!requestedActiveExists) {
      // The requested active profile no longer exists (e.g. `balanced` was
      // just pruned). Fall back to a profile that does exist; `auto` is always
      // seeded, so the chosen fallback is guaranteed to resolve.
      llm.activeProfile = resolveExistingProfile("custom-balanced");
    }
  }

  // Profile ordering — ensure all seeded profiles appear in the order array.
  // "auto" is prepended so it appears first in the picker.
  const profileOrder = Array.isArray(llm.profileOrder)
    ? (llm.profileOrder as string[])
    : [];
  const orderSet = new Set(profileOrder);
  if (!orderSet.has(AUTO_PROFILE_KEY)) {
    profileOrder.unshift(AUTO_PROFILE_KEY);
    orderSet.add(AUTO_PROFILE_KEY);
  }
  // Only managed profiles present after the reconcile are ordered, in their
  // canonical order; pruned keys are dropped from `profileOrder` below.
  for (const name of MANAGED_PROFILE_KEYS) {
    if (name in profiles && !orderSet.has(name)) {
      profileOrder.push(name);
      orderSet.add(name);
    }
  }
  if (userConnectionName) {
    for (const name of Object.keys(USER_PROFILE_TEMPLATES)) {
      if (!orderSet.has(name)) {
        profileOrder.push(name);
        orderSet.add(name);
      }
    }
  }
  // Drop any pruned profile from the order so the picker never lists a profile
  // that no longer exists. `auto` is metadata-only and always seeded.
  llm.profileOrder = profileOrder.filter(
    (name) => name === AUTO_PROFILE_KEY || name in profiles,
  );

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

function materializeProfile(
  template: ManagedProfileTemplate,
  provider: NonNullable<ProfileEntry["provider"]>,
  connectionName: string,
): ProfileEntry {
  const { intent, provider: _p, connectionName: _c, ...rest } = template;
  return {
    ...rest,
    provider,
    provider_connection: connectionName,
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

/**
 * Materialize a platform-supplied managed profile into a `ProfileEntry`,
 * resolving the model from the profile's intent client-side so the catalog
 * stays the single source of truth for "which model does this intent map to?".
 */
function materializeManagedProfile(
  p: PlatformManagedProfile,
): Record<string, unknown> {
  return {
    provider: p.provider,
    provider_connection: p.connection_name,
    model: resolveModelIntent(
      p.provider as NonNullable<ProfileEntry["provider"]>,
      p.intent as ModelIntent,
    ),
    source: "managed",
    label: p.label,
    description: p.description,
    maxTokens: p.max_tokens,
    effort: p.effort as ProfileEntry["effort"],
    thinking: {
      enabled: p.thinking.enabled,
      streamThinking: p.thinking.stream_thinking,
    },
    contextWindow: { maxInputTokens: p.context_window.max_input_tokens },
  };
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
