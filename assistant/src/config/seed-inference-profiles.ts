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
  getEffectiveProfiles,
  MANAGED_PROFILE_NAMES,
  MANAGED_PROFILE_TEMPLATES,
  materializeProfile,
  USER_PROFILE_TEMPLATES,
} from "./default-profile-catalog.js";
import { DEFAULT_PROFILE_KEYS } from "./default-profile-names.js";
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
 * Runs on every daemon startup. Default profile CONTENT is code-owned
 * (`default-profile-catalog.ts`) and resolves through the effective view
 * whether or not `llm.profiles` carries an entry, so nothing here writes
 * default bodies. Two responsibilities remain:
 *
 * 1. **BYOK hatch stubs**: a fresh off-platform install cannot use the
 *    platform-auth vellum route, so the default profiles get a thin
 *    disabled stub (`{source, status, label}`) that makes the resolver fall
 *    through to the personal `custom-*` profiles. Skipped when the hatch
 *    overlay explicitly selected a managed connection — the defaults then
 *    stay absent and resolve active from the catalog.
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
  // from the personal "custom-*" profiles that share base labels.
  const isByokMode = !isPlatform;

  // 1. BYOK hatch stubs. Default profile bodies are code-owned and never
  //    written here; the only workspace state a default carries is a thin
  //    managed stub holding the fields the effective view overlays
  //    (`source`, `status`, `label`). A fresh BYOK hatch disables the
  //    defaults so the picker doesn't offer an unusable platform-auth route
  //    on day one — and so the resolver's `custom-*` fallback applies. When
  //    the hatch overlay explicitly selected a managed connection, no stubs
  //    are written: the defaults stay absent and resolve active from the
  //    catalog, so the first post-onboarding message can use the chosen
  //    managed route. Post-hatch user toggles live on the stub and are never
  //    touched again.
  const hatchSelectedManagedConnection = getHatchSelectedManagedConnection(
    llm,
    profiles,
    options,
  );

  if (
    isByokMode &&
    options.isHatch &&
    hatchSelectedManagedConnection === undefined
  ) {
    for (const name of DEFAULT_PROFILE_KEYS) {
      if (readObject(profiles[name])) continue;
      const label = MANAGED_PROFILE_TEMPLATES[name]?.label;
      profiles[name] = {
        source: "managed",
        status: "disabled",
        ...(typeof label === "string" ? { label: `${label} (Managed)` } : {}),
      } as ProfileEntry;
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

  pruneNonDispatchableProfiles(llm, profiles);

  // Profile lookups below go through the effective view: a default profile
  // resolves from the code catalog whether or not the workspace carries a
  // stub for it, and a stub contributes only its status/label overlays.
  const effectiveProfiles = getEffectiveProfiles(
    profiles as Record<string, ProfileEntry>,
  ) as Record<string, Record<string, unknown>>;

  // Active profile resolution.
  const requestedActiveProfile = readString(llm.activeProfile);
  const requestedActiveEntry =
    requestedActiveProfile !== undefined
      ? readObject(effectiveProfiles[requestedActiveProfile])
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
      ? readObject(effectiveProfiles[requestedAdvisorProfile])
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
      effectiveProfiles,
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
    // Thin managed stubs carry no model/mix by design — their content is
    // code-owned, so dispatchability is judged on the catalog body, never
    // the stub. Only workspace-owned profiles are pruned.
    if (MANAGED_PROFILE_NAMES.has(name) && profile.source === "managed") {
      continue;
    }
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
