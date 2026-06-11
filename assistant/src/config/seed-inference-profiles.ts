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
  customProfileNameForBuiltin,
  MANAGED_PROFILE_NAMES,
  MANAGED_PROFILE_TEMPLATES,
  materializeProfile,
  USER_PROFILE_TEMPLATES,
} from "./builtin-inference-profiles.js";
import {
  isPlatformDeployment,
  loadRawConfig,
  saveRawConfig,
} from "./loader.js";
import { type ProfileEntry } from "./schemas/llm.js";

const log = getLogger("seed-inference-profiles");

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
  /**
   * Built-in profile names whose overlay entry carried provider-routing
   * fields that `mergeDefaultWorkspaceConfig` dropped during the conversion
   * to `llm.profileOverrides`. An `activeProfile` naming one of these meant
   * "this name, routed to my own provider" — not the code-defined managed
   * built-in — so the seeder remaps it to the equivalent personal `custom-*`
   * profile instead of preserving it. Only providers that get a hatch
   * personal connection land here: routing for connectionless providers
   * (ollama / openai-compatible) is transplanted to the `custom-*` name by
   * the merge itself and never reported as dropped.
   */
  builtinProfilesWithDroppedProviderConfig?: Iterable<string>;
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

  // BYOK mode = off-platform installs (the user brings their own provider
  // API key).
  const isByokMode = !isPlatformDeployment();

  // The personal connection a BYOK hatch will create (step 2), determined up
  // front because the status-override and activeProfile steps both depend on
  // whether one exists.
  const hatchProvider =
    options.isHatch && isByokMode
      ? readString(readObject(llm.default)?.provider)
      : undefined;
  const userConnectionName =
    hatchProvider &&
    hatchProvider !== "ollama" &&
    !PROVIDERS_REQUIRING_BASE_URL_AND_MODELS.has(hatchProvider)
      ? `${hatchProvider}-personal`
      : undefined;

  // A hatch overlay activeProfile naming a built-in whose provider-routing
  // fields were dropped by `mergeDefaultWorkspaceConfig` did not select the
  // code-defined managed built-in — it asked for that name routed through
  // the user's own provider. With a personal connection available, the
  // nearest equivalent is the matching `custom-*` profile; the built-in name
  // is remapped rather than preserved.
  const droppedProviderConfigNames = new Set(
    options.builtinProfilesWithDroppedProviderConfig ?? [],
  );
  const requestedActiveProfile = readString(llm.activeProfile);
  const remapActiveToCustomProfile =
    options.isHatch === true &&
    userConnectionName !== undefined &&
    requestedActiveProfile !== undefined &&
    droppedProviderConfigNames.has(requestedActiveProfile);

  // 1. BYOK hatch status overrides. A fresh BYOK hatch has no platform auth,
  //    so built-ins whose managed connection isn't the hatch-selected one
  //    must not surface as enabled in the picker on day one. The disable is
  //    persisted as a sparse `llm.profileOverrides` status entry; a
  //    pre-existing status override key (e.g. from a prior hatch or a user
  //    toggle) is never clobbered. Applied to every definition regardless of
  //    feature-flag state — an override for a flag-off profile is harmless
  //    and correct if the flag later enables.
  if (options.isHatch && isByokMode) {
    // A remapped activeProfile is not a genuine managed-connection selection
    // — the hatch routes through the personal connection, so every managed
    // profile gets the disable override.
    const hatchSelectedManagedConnection = remapActiveToCustomProfile
      ? undefined
      : getHatchSelectedManagedConnection(llm, profiles, options);
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
  if (hatchProvider && userConnectionName) {
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

  // Active profile resolution. Built-in names count as present even though
  // they are never materialized into `profiles` — the loader resolves them
  // from code at every read. A remapped built-in name is deliberately
  // treated as absent so preservation can't keep the hatch on a managed
  // profile its BYOK credential can't use.
  const requestedActiveExists =
    !remapActiveToCustomProfile &&
    requestedActiveProfile !== undefined &&
    (MANAGED_PROFILE_NAMES.has(requestedActiveProfile) ||
      readObject(profiles[requestedActiveProfile]) !== null);
  const shouldPreserveActiveProfile =
    options.preserveActiveProfile === true && requestedActiveExists;

  if (!shouldPreserveActiveProfile) {
    if (options.isHatch) {
      // Hatch = fresh setup. Pick the right default based on platform mode;
      // a remapped built-in lands on the custom profile with the same intent.
      llm.activeProfile = userConnectionName
        ? customProfileNameForBuiltin(
            remapActiveToCustomProfile ? requestedActiveProfile : undefined,
          )
        : "balanced";
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
