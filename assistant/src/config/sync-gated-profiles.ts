import { isDeepStrictEqual } from "node:util";

import { getLogger } from "../util/logger.js";
import {
  getAssistantFeatureFlagValue,
  isAssistantFeatureFlagEnabled,
} from "./assistant-feature-flags.js";
import {
  getConfigReadOnly,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "./loader.js";
import type { ProfileEntry } from "./schemas/llm.js";
import {
  materializeProfile,
  OS_BETA_FEATURE_FLAG_KEY,
  OS_BETA_PROFILE_KEY,
  OS_BETA_PROFILE_TEMPLATE,
  readObject,
} from "./seed-inference-profiles.js";

const log = getLogger("sync-gated-profiles");

export const MANAGED_BALANCED_PROFILE_KEY = "balanced";
export const MINIMAX_M3_PROVIDER_FLAG_KEY = "managed-minimax-m3-provider";

/**
 * Routing targets for the managed Balanced profile, keyed by the
 * `managed-minimax-m3-provider` flag value. Provider slug, managed connection,
 * and model id move together — each provider serves MiniMax M3 under its own
 * model id.
 */
const BALANCED_PROVIDER_TARGETS = {
  fireworks: {
    provider: "fireworks",
    provider_connection: "fireworks-managed",
    model: "accounts/fireworks/models/minimax-m3",
  },
  together: {
    provider: "together",
    provider_connection: "together-managed",
    model: "MiniMaxAI/MiniMax-M3",
  },
} as const;

/**
 * Reconcile the managed Balanced profile's provider against the
 * `managed-minimax-m3-provider` flag — the policy lever for moving MiniMax M3
 * between Fireworks and Together without a redeploy or migration. The seed
 * template owns Balanced's content; this override runs after the seed (on boot
 * and on every live flag change) and is the final authority on which provider
 * serves it. Any value other than `"together"` — including an unreachable flag
 * — holds on Fireworks, the safe default.
 *
 * Only the three routing fields are patched; everything else on Balanced is
 * shared across providers and owned by the seed template. A user-owned
 * `balanced` (`source: "user"`) is never touched.
 */
function reconcileBalancedProvider(
  profiles: Record<string, Record<string, unknown>>,
): boolean {
  const balanced = readObject(profiles[MANAGED_BALANCED_PROFILE_KEY]);
  // Absent → the seeder hasn't materialized it yet this boot; nothing to steer.
  // Only an explicit `source: "user"` opts out (mirrors the migration
  // convention; a source-less legacy managed entry is still ours).
  if (balanced == null || balanced.source === "user") return false;

  const value = getAssistantFeatureFlagValue(
    MINIMAX_M3_PROVIDER_FLAG_KEY,
    getConfigReadOnly(),
  );
  const target =
    value === "together"
      ? BALANCED_PROVIDER_TARGETS.together
      : BALANCED_PROVIDER_TARGETS.fireworks;

  if (
    balanced.provider === target.provider &&
    balanced.provider_connection === target.provider_connection &&
    balanced.model === target.model
  ) {
    return false;
  }

  balanced.provider = target.provider;
  balanced.provider_connection = target.provider_connection;
  balanced.model = target.model;
  return true;
}

/**
 * Reconcile flag-gated managed profiles against the current feature-flag state.
 *
 * `seedInferenceProfiles()` runs synchronously at boot before feature flags are
 * available, so the OS Beta profile (GLM 5.2 / fireworks-managed) is materialized
 * here once flags have loaded. When the `os-beta` flag is on, the managed profile
 * is created (ordered right after `balanced`); when it is off, a previously
 * managed entry is removed with `profileOrder` / `activeProfile` / `advisorProfile`
 * fallbacks. The reconcile is idempotent and never touches a user-owned profile of
 * the same name.
 *
 * Returns whether the on-disk config changed.
 */
export function reconcileFlagGatedProfiles(): boolean {
  const config = loadRawConfig();

  if (config.llm == null || typeof config.llm !== "object") {
    config.llm = {};
  }
  const llm = config.llm as Record<string, unknown>;

  if (llm.profiles == null || typeof llm.profiles !== "object") {
    llm.profiles = {};
  }
  const profiles = llm.profiles as Record<string, Record<string, unknown>>;

  const profileOrder = Array.isArray(llm.profileOrder)
    ? (llm.profileOrder as string[])
    : [];
  llm.profileOrder = profileOrder;

  // The resolver reads flag state from the gateway-populated override cache and
  // ignores the config argument; pass the read-only config for signature parity
  // without mutating disk before the reconcile decision is made.
  const enabled = isAssistantFeatureFlagEnabled(
    OS_BETA_FEATURE_FLAG_KEY,
    getConfigReadOnly(),
  );

  const isPlatform =
    process.env.IS_PLATFORM === "true" || process.env.IS_PLATFORM === "1";
  const isByokMode = !isPlatform;

  const previous = readObject(profiles[OS_BETA_PROFILE_KEY]);

  // Never clobber a user-owned profile that happens to be named `os-beta`. The
  // entry is ours to manage only when it is absent or already managed; a
  // user-sourced entry of the same name is left untouched on every path.
  const osBetaIsOurs = previous == null || previous.source === "managed";
  const osBetaChanged = osBetaIsOurs
    ? enabled
      ? enableProfile(profiles, profileOrder, previous, isByokMode)
      : disableProfile(llm, profiles, profileOrder, previous)
    : false;

  // Steer the managed Balanced profile's provider from the flag. Independent of
  // the os-beta path above, so it runs even when os-beta is user-owned.
  const balancedChanged = reconcileBalancedProvider(profiles);

  const changed = osBetaChanged || balancedChanged;
  if (changed) {
    saveRawConfig(config);
    invalidateConfigCache();
    log.info(
      { osBetaEnabled: enabled, osBetaChanged, balancedChanged },
      "Reconciled flag-gated profiles",
    );
  }
  return changed;
}

function enableProfile(
  profiles: Record<string, Record<string, unknown>>,
  profileOrder: string[],
  previous: Record<string, unknown> | null,
  isByokMode: boolean,
): boolean {
  const effectiveTemplate = isByokMode
    ? {
        ...OS_BETA_PROFILE_TEMPLATE,
        label: `${OS_BETA_PROFILE_TEMPLATE.label} (Managed)`,
      }
    : OS_BETA_PROFILE_TEMPLATE;
  const next = materializeProfile(
    effectiveTemplate,
    OS_BETA_PROFILE_TEMPLATE.provider,
    OS_BETA_PROFILE_TEMPLATE.connectionName,
  ) as Record<string, unknown>;

  // BYOK installs seed managed profiles disabled: the platform-auth
  // `fireworks-managed` connection backing this profile isn't usable until the
  // user enables it, so a fresh OS Beta entry starts disabled to avoid offering
  // an unusable route. A user's own status override (preserved below) wins on
  // later reconciles.
  if (isByokMode && !previous) {
    next.status = "disabled";
  }

  if (previous) {
    // The only fields a user may override on a managed profile. Carry `label`
    // by key-presence so an explicit null (user cleared it) survives too.
    if ("label" in previous) next.label = previous.label;
    if ("status" in previous) next.status = previous.status;
    if ("advisorEnabled" in previous) {
      next.advisorEnabled = previous.advisorEnabled;
    }
  }

  let changed = false;
  if (!previous || !isDeepStrictEqual(previous, next)) {
    profiles[OS_BETA_PROFILE_KEY] = next as ProfileEntry;
    changed = true;
  }

  if (!profileOrder.includes(OS_BETA_PROFILE_KEY)) {
    const balancedIndex = profileOrder.indexOf("balanced");
    if (balancedIndex >= 0) {
      profileOrder.splice(balancedIndex + 1, 0, OS_BETA_PROFILE_KEY);
    } else {
      profileOrder.push(OS_BETA_PROFILE_KEY);
    }
    changed = true;
  }

  return changed;
}

// `MixSchema = z.array(MixArmSchema).min(2)` in schemas/llm.ts: mixes require
// >= 2 arms. A mix that drops below this is invalid and cannot be kept.
const MIX_MIN_ARMS = 2;

function disableProfile(
  llm: Record<string, unknown>,
  profiles: Record<string, Record<string, unknown>>,
  profileOrder: string[],
  previous: Record<string, unknown> | null,
): boolean {
  if (!previous) return false;

  delete profiles[OS_BETA_PROFILE_KEY];

  // The removal closure: every name here is absent from `profiles` once the
  // closure settles, so the written config can never reference one. A mix that
  // loses arms below the >= 2 minimum is itself invalid, so it joins the set
  // and the loop runs to a fixpoint to resolve any references that cascade.
  const removed = new Set<string>([OS_BETA_PROFILE_KEY]);
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

  llm.profileOrder = profileOrder.filter((name) => !removed.has(name));

  if (typeof llm.activeProfile === "string" && removed.has(llm.activeProfile)) {
    llm.activeProfile = "balanced";
  }
  if (
    typeof llm.advisorProfile === "string" &&
    removed.has(llm.advisorProfile)
  ) {
    // Repoint the advisor at the managed Frontier profile (the strongest).
    // `frontier` is seeded unconditionally every boot, so target it even if it
    // has not been materialized yet this startup — this reconcile can run before
    // the seeder in the boot sequence, and the later seeder won't rewrite an
    // already-set `advisorProfile`. The exception is a user-owned profile named
    // `frontier`: that is not ours to route to, so fall back to the
    // always-managed Quality profile, then clear the pointer as a last resort.
    const frontierEntry = readObject(profiles["frontier"]);
    const frontierIsUserOwned =
      frontierEntry !== null && frontierEntry.source !== "managed";
    if (!frontierIsUserOwned) {
      llm.advisorProfile = "frontier";
    } else if (readObject(profiles["quality-optimized"]) !== null) {
      llm.advisorProfile = "quality-optimized";
    } else {
      delete llm.advisorProfile;
    }
  }

  // Clear any call-site `profile` reference to a removed profile; other override
  // fields on the entry stay intact (an empty override object is valid).
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

  return true;
}
