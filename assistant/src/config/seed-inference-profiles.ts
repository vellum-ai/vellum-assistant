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
} from "./default-profile-catalog.js";
import { loadRawConfig, saveRawConfig } from "./loader.js";
import { isDispatchableProfile } from "./profile-dispatchability.js";
import { isDefaultProviderChoice, type ProfileEntry } from "./schemas/llm.js";

const log = getLogger("seed-inference-profiles");

export const OS_BETA_FEATURE_FLAG_KEY = "os-beta";

const MIX_MIN_ARMS = 2;

export type SeedInferenceProfilesOptions = {
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
 * default bodies. Three responsibilities remain:
 *
 * 1. **Personal provider connection**: a BYOK hatch creates the
 *    `<provider>-personal` connection backed by the user's API key in CES.
 *    The BYOK columns of the intent × provider matrix stamp exactly that
 *    connection name (via `resolveDefaultConnectionName`), so the default
 *    profiles dispatch through it.
 *
 * 2. **`llm.defaultProvider`**: written once at hatch time, mirroring the
 *    platform/managed/BYOK decision, and never overwritten afterward. The
 *    default profiles resolve through this provider's matrix column.
 *
 * 3. **Active/advisor profile resolution**: hatches activate `balanced`;
 *    boots repair dangling or disabled selections.
 */
export function seedInferenceProfiles(
  options: SeedInferenceProfilesOptions = {},
): void {
  const config = loadRawConfig();

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

  // A hatch overlay that explicitly selected a managed connection routes the
  // default provider through vellum rather than the entered BYOK key.
  const hatchSelectedManagedConnection = didHatchSelectManagedConnection(
    llm,
    profiles,
    options,
  );

  // 1. Personal provider connection: only at hatch time for off-platform
  //    installations, backed by the user's API key in CES. The BYOK columns
  //    of the intent × provider matrix stamp `<provider>-personal` (via
  //    `resolveDefaultConnectionName`), so the connection must exist for the
  //    default profiles to dispatch.
  let usableHatchProvider: string | undefined;
  if (options.isHatch && !isPlatform) {
    const hatchProvider = readString(readObject(llm.default)?.provider);
    if (
      hatchProvider &&
      hatchProvider !== "ollama" &&
      !PROVIDERS_REQUIRING_BASE_URL_AND_MODELS.has(hatchProvider)
    ) {
      usableHatchProvider = hatchProvider;
      // Same predicate `resolveHatchDefaultProvider` applies below: a
      // provider can pass the connection gate (key stored, personal
      // connection created) yet not qualify as a default-provider choice
      // (e.g. litellm, whose catalog defaultModel is empty). Surface that
      // divergence here, at the point the connection is still created.
      if (!isDefaultProviderChoice(hatchProvider)) {
        log.warn(
          { provider: hatchProvider },
          "Hatch provider key stored and personal connection created, but the provider cannot back the default profiles; llm.defaultProvider will fall back to anthropic",
        );
      }
      const userConnectionName = `${hatchProvider}-personal`;

      if (options.db && !getConnection(options.db, userConnectionName)) {
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
  }

  // 2. Default provider: hatch only, never overwritten once set. Always
  //    populated — even dangling, so later resolution can prompt the user
  //    for a key explainably rather than hitting an unset branch.
  if (options.isHatch && readObject(llm.defaultProvider) === null) {
    llm.defaultProvider = {
      provider: resolveHatchDefaultProvider(
        isPlatform,
        hatchSelectedManagedConnection,
        usableHatchProvider,
      ),
    };
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
    if (options.isHatch || !requestedActiveExists) {
      llm.activeProfile = "balanced";
    }
  }

  // Advisor profile: defaults to the strongest active managed default.
  const requestedAdvisorProfile = readString(llm.advisorProfile);
  const requestedAdvisorEntry =
    requestedAdvisorProfile !== undefined
      ? readObject(effectiveProfiles[requestedAdvisorProfile])
      : null;
  const requestedAdvisorIsDisabledManaged =
    requestedAdvisorEntry?.source === "managed" &&
    requestedAdvisorEntry.status === "disabled";
  if (
    requestedAdvisorProfile === undefined ||
    requestedAdvisorIsDisabledManaged
  ) {
    const defaultAdvisorProfile = firstActiveManagedProfile(effectiveProfiles, [
      "quality-optimized",
      "balanced",
      "cost-optimized",
    ]);
    if (defaultAdvisorProfile) {
      llm.advisorProfile = defaultAdvisorProfile;
    } else if (requestedAdvisorIsDisabledManaged) {
      delete llm.advisorProfile;
    }
  }

  // Profile ordering: ensure all seeded profiles appear in the order array.
  // A managed key absent from a workspace's order is placed next to the
  // sibling that precedes it in the catalog rather than appended, so the
  // managed profiles stay grouped in catalog order even on a workspace whose
  // order already lists custom profiles. Entries already in the order keep
  // their relative positions, so a user arrangement survives.
  const profileOrder = Array.isArray(llm.profileOrder)
    ? (llm.profileOrder as string[])
    : [];
  const managedNames = Object.keys(MANAGED_PROFILE_TEMPLATES);
  for (const [index, name] of managedNames.entries()) {
    if (profileOrder.includes(name)) {
      continue;
    }
    const anchor = managedNames
      .slice(0, index)
      .reverse()
      .map((sibling) => profileOrder.indexOf(sibling))
      .find((position) => position >= 0);
    if (anchor === undefined) {
      profileOrder.push(name);
    } else {
      profileOrder.splice(anchor + 1, 0, name);
    }
  }
  llm.profileOrder = profileOrder;

  // Tag any remaining profiles without a source as user-created.
  for (const [name, profile] of Object.entries(profiles)) {
    if (MANAGED_PROFILE_NAMES.has(name)) {
      continue;
    }
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

function resolveHatchDefaultProvider(
  isPlatform: boolean,
  selectedManagedConnection: boolean,
  hatchProvider: string | undefined,
): string {
  // Platform mode and an explicit managed-connection selection both route
  // through vellum.
  if (isPlatform || selectedManagedConnection) {
    return "vellum";
  }
  if (hatchProvider !== undefined && isDefaultProviderChoice(hatchProvider)) {
    return hatchProvider;
  }
  log.warn(
    { provider: hatchProvider ?? null },
    "Hatch provider cannot back the default profiles; falling back to anthropic",
  );
  return "anthropic";
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
  if (removed.size === 0) {
    return;
  }

  let cascading = true;
  while (cascading) {
    cascading = false;
    for (const [name, profile] of Object.entries(profiles)) {
      if (removed.has(name)) {
        continue;
      }
      if (!Array.isArray(profile.mix)) {
        continue;
      }
      const arms = profile.mix as unknown[];
      const kept = arms.filter((arm) => {
        const armProfile = readObject(arm)?.profile;
        return typeof armProfile !== "string" || !removed.has(armProfile);
      });
      if (kept.length === arms.length) {
        continue;
      }
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

function didHatchSelectManagedConnection(
  llm: Record<string, unknown>,
  profiles: Record<string, Record<string, unknown>>,
  options: SeedInferenceProfilesOptions,
): boolean {
  if (!options.isHatch || options.preserveActiveProfile !== true) {
    return false;
  }

  const activeProfile = readString(llm.activeProfile);
  if (!activeProfile) {
    return false;
  }

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
    return (
      explicitConnection !== undefined &&
      MANAGED_CONNECTION_NAMES.has(explicitConnection)
    );
  }

  // A default-profile name with no explicit connection selects the managed
  // route: the vellum column IS the managed column, and its profiles route
  // through the canonical vellum row.
  return MANAGED_PROFILE_TEMPLATES[activeProfile] !== undefined;
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
