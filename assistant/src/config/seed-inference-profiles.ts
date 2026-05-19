import type { DrizzleDb } from "../memory/db-connection.js";
import {
  createConnection,
  disableManagedConnectionsForByokHatch,
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
 * Managed profiles. Overwritten on every daemon boot so Vellum can push
 * model/config updates to customers in new releases. Platform overlays
 * (`preserveProfileNames`) take precedence when present.
 */
const MANAGED_PROFILE_TEMPLATES: Record<string, ManagedProfileTemplate> = {
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
    effort: "max",
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
    effort: "max",
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

export const MANAGED_PROFILE_NAMES = new Set(
  Object.keys(MANAGED_PROFILE_TEMPLATES),
);

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
 * 1. **Managed profiles** (`balanced`, `quality-optimized`, `cost-optimized`):
 *    overwritten on every boot so Vellum can push model/config updates to
 *    customers. Each carries `provider_connection: "anthropic-managed"`.
 *    Platform overlays (`preserveProfileNames`) take precedence.
 *
 * 2. **User profiles** (`custom-balanced`, `custom-quality-optimized`,
 *    `custom-cost-optimized`): materialized once at hatch time for
 *    off-platform installations. Each points at a personal provider
 *    connection backed by the user's API key in CES. Subsequent boots
 *    leave these untouched — the user owns them.
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

  // BYOK mode = off-platform installs. The user is bringing their own provider
  // API key; managed profile labels get a " (Managed)" suffix to disambiguate
  // from the personal "custom-*" profiles that share base labels. Managed
  // profile + connection status is initially "disabled" so the picker doesn't
  // offer an unusable platform-auth option on day one — but ONLY at hatch
  // time, and ONLY when the entry isn't already in the user's config (i.e.
  // first materialization). Post-hatch user toggles survive every subsequent
  // boot.
  const isByokMode = !isPlatform;

  // 1. Managed profiles. Off-platform: overwrite on every boot so Vellum can
  //    push model/config updates in new releases. On-platform: insert only if
  //    absent — the platform controls profiles through overlays, and the
  //    overlay fragment is authoritative even when it omits fields the local
  //    template carries (e.g. an overlay supplying only provider/model/label
  //    must not get its maxTokens/thinking polluted from the template). The
  //    legacy migration-052 backfill that seeds label-less Anthropic
  //    defaults is healed by workspace migration 082
  //    (`backfill-managed-profile-labels`) rather than the seeder, so
  //    this skip path stays simple.
  //
  //    Two user-editable fields survive the overwrite: `label` (display
  //    rename) and `status` (active/disabled toggle). The PUT route
  //    `/v1/config/llm/profiles/:name` lets users patch these on managed
  //    profiles without duplicating; we have to honor those edits across
  //    reseeds or they'd silently revert on every boot. Carry by
  //    key-presence rather than truthiness so an explicit `null` (user
  //    cleared the label) survives too. Codex P1 finding on PR #30362.
  //
  //    BYOK seed defaults (off-platform only):
  //      • label: " (Managed)" suffix disambiguates managed profile labels
  //        from personal "custom-*" profiles that share base labels.
  //        Upgrade migration: existing installs that already have the bare
  //        template label ("Balanced" / "Quality" / "Speed") on disk get
  //        rewritten to the suffixed form. Any other previous label value
  //        (user-set custom string, explicit null, already-suffixed) is
  //        preserved as-is.
  //      • status: "disabled" on fresh materialization at hatch only —
  //        gated on (isHatch && !previous) so post-hatch boots and existing
  //        installs are never auto-disabled. A user re-enable persists
  //        across boots via the key-presence preservation below.
  for (const [name, template] of Object.entries(MANAGED_PROFILE_TEMPLATES)) {
    if (preservedProfileNames.has(name)) continue;
    if (isPlatform && readObject(profiles[name]) !== null) continue;

    const previous = readObject(profiles[name]);
    const effectiveTemplate: ManagedProfileTemplate = isByokMode
      ? { ...template, label: `${template.label} (Managed)` }
      : template;
    const next = materializeProfile(
      effectiveTemplate,
      template.provider,
      template.connectionName,
    ) as Record<string, unknown>;
    if (isByokMode && options.isHatch && !previous) {
      next.status = "disabled";
    }
    if (previous) {
      // Preserve user overrides on these whitelisted fields. The label path
      // also runs the BYOK upgrade migration described above: if the on-disk
      // label exactly equals the bare template default and we're in BYOK
      // mode, rewrite to the suffixed effective label so existing installs
      // get the disambiguation, not just fresh hatches.
      if ("label" in previous) {
        next.label =
          isByokMode && previous.label === template.label
            ? effectiveTemplate.label
            : previous.label;
      }
      if ("status" in previous) next.status = previous.status;
    }
    profiles[name] = next as ProfileEntry;
  }

  // 2. User profiles — only at hatch time for off-platform installations.
  let userConnectionName: string | undefined;
  if (options.isHatch && !isPlatform) {
    // BYOK hatch: disable the three canonical managed connections so the
    // picker doesn't surface unusable platform-auth options on day one.
    // Runs only here, only at hatch — `seedCanonicalConnections` leaves
    // `status` alone on subsequent boots so a post-hatch user re-enable
    // persists.
    if (options.db) {
      disableManagedConnectionsForByokHatch(options.db);
    }

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

  if (!shouldPreserveActiveProfile) {
    if (options.isHatch) {
      // Hatch = fresh setup. Pick the right default based on platform mode.
      llm.activeProfile = userConnectionName ? "custom-balanced" : "balanced";
    } else if (!requestedActiveExists) {
      llm.activeProfile = "balanced";
    }
  }

  // Profile ordering — ensure all seeded profiles appear in the order array.
  const profileOrder = Array.isArray(llm.profileOrder)
    ? (llm.profileOrder as string[])
    : [];
  const orderSet = new Set(profileOrder);
  for (const name of Object.keys(MANAGED_PROFILE_TEMPLATES)) {
    if (!orderSet.has(name)) {
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
  llm.profileOrder = profileOrder;

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
