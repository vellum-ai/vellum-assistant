import type { DrizzleDb } from "../memory/db-connection.js";
import {
  createConnection,
  getConnection,
  MANAGED_CONNECTION_NAMES,
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
  // Exactly one of `intent` or `model` must be set. `intent` resolves the
  // model from the catalog at seed time; `model` pins an explicit model id.
  intent?: ModelIntent;
  model?: string;
  provider: NonNullable<ProfileEntry["provider"]>;
  connectionName: string;
};

/**
 * Managed profiles. Overwritten on every daemon boot so Vellum can push
 * model/config updates to customers in new releases. Platform overlays
 * (`preserveProfileNames`) take precedence when present.
 */
const MANAGED_PROFILE_TEMPLATES: Record<string, ManagedProfileTemplate> = {
  // Served by MiniMax M3 on Fireworks via managed platform inference: a strong
  // open model at a lower price point than the managed Anthropic route.
  balanced: {
    intent: "balanced",
    provider: "fireworks",
    connectionName: "fireworks-managed",
    source: "managed",
    label: "Balanced",
    description: "Good balance of quality, cost, and speed",
    maxTokens: 32000,
    effort: "high",
    thinking: { enabled: true, streamThinking: true },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
    topP: 0.95,
  },
  // Served by GLM 5.2 on Fireworks via managed platform inference: a leading
  // open model. `model` is pinned explicitly rather than resolved via the
  // `quality-optimized` intent (which still maps to Anthropic Opus for the
  // `frontier` profile below).
  "quality-optimized": {
    model: "accounts/fireworks/models/glm-5p2",
    provider: "fireworks",
    connectionName: "fireworks-managed",
    source: "managed",
    label: "Quality",
    description: "High-quality results with a leading open model (GLM 5.2)",
    maxTokens: 32000,
    effort: "high",
    thinking: { enabled: true, streamThinking: true },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
  frontier: {
    intent: "quality-optimized",
    provider: "anthropic",
    connectionName: "anthropic-managed",
    source: "managed",
    label: "Frontier",
    description: "Best results with the most capable model",
    maxTokens: 32000,
    effort: "high",
    thinking: { enabled: true, streamThinking: true },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
    // This is the advisor's own (strongest) profile: when it's also the chat
    // profile there's nothing stronger to consult, so the advisor defaults off.
    advisorEnabled: false,
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

export const OS_BETA_PROFILE_KEY = "os-beta";
export const OS_BETA_FEATURE_FLAG_KEY = "os-beta";

/**
 * Flag-gated managed profile. NOT in MANAGED_PROFILE_TEMPLATES, so the
 * unconditional boot seed never creates it. Reconciled in/out by
 * the flag-gated profile reconcile based on the `os-beta` feature flag.
 * Balanced-parity defaults; GLM 5.2 pinned explicitly via `model`.
 */
export const OS_BETA_PROFILE_TEMPLATE: ManagedProfileTemplate = {
  model: "accounts/fireworks/models/glm-5p2",
  provider: "fireworks",
  connectionName: "fireworks-managed",
  source: "managed",
  label: "OS Beta",
  description: "Open-source frontier model (GLM 5.2), in beta",
  maxTokens: 32000,
  effort: "high",
  thinking: { enabled: true, streamThinking: true },
  contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
};

// Membership here marks a name as managed. The route layer applies managed
// restrictions (blocking model/provider edits and deletion) only to entries
// whose on-disk `source` is `managed`, so a user-owned profile sharing one of
// these names is not locked. `OS_BETA_PROFILE_KEY` is flag-gated: it is
// materialized by the flag-gated profile reconcile, which refuses to touch a
// same-named user profile.
export const MANAGED_PROFILE_NAMES = new Set([
  ...Object.keys(MANAGED_PROFILE_TEMPLATES),
  OS_BETA_PROFILE_KEY,
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
 * 1. **Managed profiles** (`balanced`, `quality-optimized`,
 *    `cost-optimized`): reconciled from the code templates on every boot —
 *    on-platform and off-platform alike — so Vellum can push model/config
 *    updates to customers in a release without a workspace migration. The
 *    templates own all profile content; `label`, `status`, `advisorEnabled`,
 *    and `topP` are user overrides that survive reseeds. Of those, only
 *    `label`, `status`, and `topP` are editable through the managed PUT route
 *    allowlist; `advisorEnabled` is edited via the generic config path but is
 *    still preserved here so it survives reboots.
 *    Platform overlays (`preserveProfileNames`) take precedence for the boot
 *    they are supplied.
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
  // profile + connection status is initially "disabled" for true BYOK hatches
  // so the picker doesn't offer an unusable platform-auth option on day one.
  // When the hatch overlay explicitly selects a managed profile, the matching
  // managed connection stays active so the first post-onboarding message can
  // use the user's chosen managed route. Post-hatch user toggles survive every
  // subsequent boot.
  const isByokMode = !isPlatform;

  // 1. Managed profiles. Reconciled from the code templates on every boot —
  //    on-platform and off-platform alike — so Vellum can push model/config
  //    updates in new releases just by editing `MANAGED_PROFILE_TEMPLATES` /
  //    `model-intents.ts` and shipping a release, with no workspace migration.
  //    The templates are the single source of truth for profile *content*
  //    (model, maxTokens, effort, thinking, description, provider/connection).
  //
  //    Platform overlays (`preserveProfileNames`) still take precedence for the
  //    boot they are supplied: a profile named in the overlay is skipped here so
  //    the overlay fragment lands verbatim and is never polluted by template
  //    fields it omits. The overlay is a one-time hatch input (archived after
  //    its first merge), so on subsequent boots the templates reconcile content
  //    as usual.
  //
  //    A whitelist of user-editable fields survives the reconcile: `label`
  //    (display rename), `status` (active/disabled toggle), `advisorEnabled`
  //    (per-profile advisor toggle), and `topP` (sampling override) — the only
  //    fields a user may override. The managed PUT route
  //    `/v1/config/llm/profiles/:name` lets users patch `label`, `status`, and
  //    `topP` on managed profiles without duplicating (its editable allowlist,
  //    `MANAGED_PROFILE_EDITABLE_KEYS`, deliberately excludes `advisorEnabled`,
  //    which is set through the generic config path). We honor every one of
  //    these overrides across reseeds or they'd silently revert on every boot.
  //    Carry by key-presence rather than truthiness so an explicit `null` (user
  //    cleared the field) survives too.
  //
  //    BYOK seed defaults (off-platform only):
  //      • label: " (Managed)" suffix disambiguates managed profile labels
  //        from personal "custom-*" profiles that share base labels.
  //        Upgrade migration: existing installs that already have the bare
  //        template label ("Balanced" / "Quality" / "Speed") on disk get
  //        rewritten to the suffixed form. Any other previous label value
  //        (user-set custom string, explicit null, already-suffixed) is
  //        preserved as-is.
  //      • status: "disabled" on fresh materialization at BYOK hatch only —
  //        gated on (isHatch && !previous) and skipped for any managed
  //        connection explicitly selected by the hatch overlay. Post-hatch
  //        boots and existing installs are never auto-disabled. A user
  //        re-enable persists across boots via the key-presence preservation
  //        below.
  const hatchSelectedManagedConnection = getHatchSelectedManagedConnection(
    llm,
    profiles,
    options,
  );

  for (const [name, template] of Object.entries(MANAGED_PROFILE_TEMPLATES)) {
    if (preservedProfileNames.has(name)) continue;

    const previous = readObject(profiles[name]);
    // Never clobber a user-owned profile that happens to share a managed name.
    // Older workspaces may already hold a user profile under a name we are only
    // now reserving as managed (e.g. `frontier`); reseeding it would change its
    // provider/model and mark it managed. This mirrors the flag-gated reconcile,
    // which only manages an entry it already owns.
    if (previous?.source === "user") continue;
    const effectiveTemplate: ManagedProfileTemplate = isByokMode
      ? { ...template, label: `${template.label} (Managed)` }
      : template;
    const next = materializeProfile(
      effectiveTemplate,
      template.provider,
      template.connectionName,
    ) as Record<string, unknown>;
    if (
      isByokMode &&
      options.isHatch &&
      !previous &&
      template.connectionName !== hatchSelectedManagedConnection
    ) {
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
      // The per-profile advisor toggle is a user override — preserve it across
      // reseeds so a user's choice survives reboots (the template value only
      // seeds the initial default, e.g. off for quality-optimized).
      if ("advisorEnabled" in previous) {
        next.advisorEnabled = previous.advisorEnabled;
      }
      // `topP` is user-editable on managed profiles (see the managed-profile
      // editable allowlist on the PUT route) — preserve a user override across
      // reseeds, including an explicit `null` clear, or it would silently revert
      // to the template value on every boot. Carry by key-presence (not
      // truthiness) so `null` survives too.
      if ("topP" in previous) next.topP = previous.topP;
    }
    profiles[name] = next as ProfileEntry;
  }

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

  if (!shouldPreserveActiveProfile) {
    if (options.isHatch) {
      // Hatch = fresh setup. Pick the right default based on platform mode.
      llm.activeProfile = userConnectionName ? "custom-balanced" : "balanced";
    } else if (!requestedActiveExists) {
      llm.activeProfile = "balanced";
    }
  }

  // Advisor profile: default to the strongest managed profile when unset, so
  // the advisor consults `frontier` (Anthropic Opus) out of the box, falling
  // back to `quality-optimized` if `frontier` is unavailable. The `frontier`
  // arm requires managed ownership: the seed loop above leaves a user-owned
  // profile named `frontier` in place, and pointing the advisor at that would
  // consult an arbitrary user model. Guarded on existence so it never names a
  // missing profile (superRefine rejects that); off-platform/BYOK installs can
  // repoint it at one of their own profiles.
  if (readString(llm.advisorProfile) === undefined) {
    if (readObject(profiles["frontier"])?.source === "managed") {
      llm.advisorProfile = "frontier";
    } else if (readObject(profiles["quality-optimized"]) !== null) {
      llm.advisorProfile = "quality-optimized";
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

export function materializeProfile(
  template: ManagedProfileTemplate,
  provider: NonNullable<ProfileEntry["provider"]>,
  connectionName: string,
): ProfileEntry {
  const { intent, model, provider: _p, connectionName: _c, ...rest } = template;
  const resolvedModel =
    model ?? (intent ? resolveModelIntent(provider, intent) : undefined);
  if (!resolvedModel) {
    throw new Error("ManagedProfileTemplate requires `intent` or `model`");
  }
  return {
    ...rest,
    provider,
    provider_connection: connectionName,
    model: resolvedModel,
  };
}

export function readObject(value: unknown): Record<string, unknown> | null {
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

  const activeProfileEntry = readObject(profiles[activeProfile]);
  if (
    activeProfileEntry &&
    Object.prototype.hasOwnProperty.call(
      activeProfileEntry,
      "provider_connection",
    )
  ) {
    const explicitConnection = readString(
      activeProfileEntry.provider_connection,
    );
    return explicitConnection &&
      MANAGED_CONNECTION_NAMES.has(explicitConnection)
      ? explicitConnection
      : undefined;
  }

  const templateConnection =
    MANAGED_PROFILE_TEMPLATES[activeProfile]?.connectionName;
  return templateConnection && MANAGED_CONNECTION_NAMES.has(templateConnection)
    ? templateConnection
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
