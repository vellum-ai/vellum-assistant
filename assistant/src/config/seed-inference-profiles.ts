import type { DrizzleDb } from "../persistence/db-connection.js";
import { PROVIDERS_REQUIRING_BASE_URL_AND_MODELS } from "../providers/inference/auth.js";
import {
  createConnection,
  getConnection,
  MANAGED_CONNECTION_NAMES,
} from "../providers/inference/connections.js";
import { PROVIDER_CATALOG } from "../providers/model-catalog.js";
import { credentialKey } from "../security/credential-key.js";
import { getLogger } from "../util/logger.js";
import {
  type DefaultProfileTemplate,
  MANAGED_PROFILE_NAMES,
  MANAGED_PROFILE_TEMPLATES,
  materializeProfile,
  USER_PROFILE_TEMPLATES,
} from "./default-profile-catalog.js";
import { loadRawConfig, saveRawConfig } from "./loader.js";
import { isDispatchableProfile } from "./profile-dispatchability.js";
import type { ProfileEntry } from "./schemas/llm.js";

const log = getLogger("seed-inference-profiles");

export const OS_BETA_FEATURE_FLAG_KEY = "os-beta";

const MIX_MIN_ARMS = 2;

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
 *    templates own all profile content; on-disk `label`, `status`, and `topP`
 *    overrides survive reseeds (the BYOK label suffix and hatch-time disable
 *    rely on this).
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
  //    updates in new releases just by editing `default-profile-catalog.ts`
  //    and shipping a release, with no workspace migration. The catalog is
  //    the single source of truth for profile *content* (model, maxTokens,
  //    effort, thinking, description, provider/connection).
  //
  //    Platform overlays (`preserveProfileNames`) still take precedence for the
  //    boot they are supplied: a profile named in the overlay is skipped here so
  //    the overlay fragment lands verbatim and is never polluted by template
  //    fields it omits. The overlay is a one-time hatch input (archived after
  //    its first merge), so on subsequent boots the templates reconcile content
  //    as usual.
  //
  //    A whitelist of fields survives the reconcile: `label`, `status`, and
  //    `topP` are preserved from disk across reseeds so the BYOK hatch-time
  //    disable and any pre-existing overrides don't silently revert on every
  //    boot. Managed-source profiles reject all user-facing edits except the
  //    disabled→active re-enable (enforced at the route layer's commit
  //    guard), so these preserved fields are frozen, not editable. Carry by
  //    key-presence rather than truthiness so an explicit `null` (cleared
  //    field) survives too.
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
    const effectiveTemplate: DefaultProfileTemplate = isByokMode
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
      // Preserve on-disk overrides of these whitelisted fields. The label path
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
      // A pre-existing on-disk `topP` override is frozen by the invariant
      // guard but must still survive reseeds, including an explicit `null`
      // clear — otherwise it would silently revert to the template value on
      // every boot. Carry by key-presence (not truthiness) so `null`
      // survives too.
      if ("topP" in previous) next.topP = previous.topP;
    }
    profiles[name] = next as ProfileEntry;
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

  pruneNonDispatchableProfiles(llm, profiles);

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

  // Advisor profile: BYOK hatches default to the strongest personal profile
  // backed by the entered provider key. Managed-profile hatches and registered
  // platform installs default to the strongest active managed profile.
  const requestedAdvisorProfile = readString(llm.advisorProfile);
  const requestedAdvisorEntry =
    requestedAdvisorProfile !== undefined
      ? readObject(profiles[requestedAdvisorProfile])
      : null;
  const requestedAdvisorIsDisabledManaged =
    requestedAdvisorEntry?.source === "managed" &&
    requestedAdvisorEntry.status === "disabled";
  const preferPersonalAdvisor =
    userConnectionName !== undefined &&
    hatchSelectedManagedConnection === undefined;
  if (
    requestedAdvisorProfile === undefined ||
    requestedAdvisorIsDisabledManaged
  ) {
    const defaultAdvisorProfile = selectDefaultAdvisorProfile(
      profiles,
      preferPersonalAdvisor,
    );
    if (defaultAdvisorProfile) {
      llm.advisorProfile = defaultAdvisorProfile;
    } else if (requestedAdvisorIsDisabledManaged) {
      delete llm.advisorProfile;
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

export function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pruneNonDispatchableProfiles(
  llm: Record<string, unknown>,
  profiles: Record<string, Record<string, unknown>>,
): void {
  const removed = new Set<string>();
  for (const [name, profile] of Object.entries(profiles)) {
    if (!isDispatchableProfile(profile)) {
      delete profiles[name];
      removed.add(name);
    }
  }
  pruneRemovedProfileReferences(llm, profiles, removed);
}

function pruneRemovedProfileReferences(
  llm: Record<string, unknown>,
  profiles: Record<string, Record<string, unknown>>,
  removed: Set<string>,
): void {
  if (removed.size === 0) return;

  let cascading = true;
  while (cascading) {
    cascading = false;
    for (const [name, profile] of Object.entries(profiles)) {
      if (removed.has(name)) continue;
      if (!Array.isArray(profile.mix)) continue;
      const arms = profile.mix as unknown[];
      const kept = arms.filter((arm) => {
        const armProfile = readObject(arm)?.profile;
        return typeof armProfile !== "string" || !removed.has(armProfile);
      });
      if (kept.length === arms.length) continue;
      if (kept.length >= MIX_MIN_ARMS) {
        profile.mix = kept;
      } else {
        delete profiles[name];
        removed.add(name);
      }
      cascading = true;
    }
  }

  if (Array.isArray(llm.profileOrder)) {
    llm.profileOrder = (llm.profileOrder as unknown[]).filter(
      (name) => typeof name !== "string" || !removed.has(name),
    );
  }

  if (
    typeof llm.advisorProfile === "string" &&
    removed.has(llm.advisorProfile)
  ) {
    delete llm.advisorProfile;
  }

  const callSites = readObject(llm.callSites);
  if (callSites) {
    for (const entry of Object.values(callSites)) {
      const site = readObject(entry);
      if (
        site &&
        typeof site.profile === "string" &&
        removed.has(site.profile)
      ) {
        delete site.profile;
      }
    }
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function selectDefaultAdvisorProfile(
  profiles: Record<string, Record<string, unknown>>,
  preferPersonalProfile: boolean,
): string | undefined {
  const personal = firstActiveProfile(profiles, [
    "custom-quality-optimized",
    "custom-balanced",
    "custom-cost-optimized",
  ]);
  const managed = firstActiveManagedProfile(profiles, [
    "quality-optimized",
    "balanced",
    "cost-optimized",
  ]);
  return preferPersonalProfile ? (personal ?? managed) : (managed ?? personal);
}

function firstActiveProfile(
  profiles: Record<string, Record<string, unknown>>,
  names: string[],
): string | undefined {
  for (const name of names) {
    const profile = readObject(profiles[name]);
    if (profile && profile.status !== "disabled") return name;
  }
  return undefined;
}

function firstActiveManagedProfile(
  profiles: Record<string, Record<string, unknown>>,
  names: string[],
): string | undefined {
  for (const name of names) {
    const profile = readObject(profiles[name]);
    if (profile?.source === "managed" && profile.status !== "disabled") {
      return name;
    }
  }
  return undefined;
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
