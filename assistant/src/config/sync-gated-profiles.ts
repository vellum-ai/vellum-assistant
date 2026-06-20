import { isDeepStrictEqual } from "node:util";

import { getLogger } from "../util/logger.js";
import { isAssistantFeatureFlagEnabled } from "./assistant-feature-flags.js";
import {
  getConfigReadOnly,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "./loader.js";
import type { ProfileEntry } from "./schemas/llm.js";
import {
  type ManagedProfileTemplate,
  materializeProfile,
  OS_BETA_FEATURE_FLAG_KEY,
  OS_BETA_PROFILE_KEY,
  OS_BETA_PROFILE_TEMPLATE,
  readObject,
  VISION_PERCEPTION_FLAG_KEY,
  VISION_PROFILE_KEY,
  VISION_PROFILE_TEMPLATE,
} from "./seed-inference-profiles.js";

const log = getLogger("sync-gated-profiles");

/**
 * A managed profile reconciled in/out of the workspace config based on a single
 * feature flag. `seedInferenceProfiles()` runs synchronously at boot before
 * feature flags are available, so these profiles are materialized here once
 * flags have loaded.
 */
type FlagGatedProfile = {
  flagKey: string;
  profileKey: string;
  template: ManagedProfileTemplate;
};

const FLAG_GATED_PROFILES: FlagGatedProfile[] = [
  {
    flagKey: OS_BETA_FEATURE_FLAG_KEY,
    profileKey: OS_BETA_PROFILE_KEY,
    template: OS_BETA_PROFILE_TEMPLATE,
  },
  {
    flagKey: VISION_PERCEPTION_FLAG_KEY,
    profileKey: VISION_PROFILE_KEY,
    template: VISION_PROFILE_TEMPLATE,
  },
];

/**
 * Reconcile flag-gated managed profiles against the current feature-flag state.
 *
 * `seedInferenceProfiles()` runs synchronously at boot before feature flags are
 * available, so each flag-gated profile (e.g. OS Beta / GLM 5.2, or the vision
 * profile / Qwen 3.7 Plus, both on fireworks-managed) is materialized here once
 * flags have loaded. When a profile's flag is on the managed entry is created
 * (ordered right after `balanced`); when it is off, a previously managed entry
 * is removed with `profileOrder` / `activeProfile` / `advisorProfile` /
 * call-site / mix fallbacks. The reconcile is idempotent and never touches a
 * user-owned profile of the same name.
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

  const isPlatform =
    process.env.IS_PLATFORM === "true" || process.env.IS_PLATFORM === "1";
  const isByokMode = !isPlatform;

  let changed = false;
  for (const gated of FLAG_GATED_PROFILES) {
    const previous = readObject(profiles[gated.profileKey]);

    // Never clobber a user-owned profile that happens to share this name. The
    // entry is ours to manage only when it is absent or already managed; a
    // user-sourced entry of the same name is left untouched on every path.
    const isOursToManage = previous == null || previous.source === "managed";
    if (!isOursToManage) {
      continue;
    }

    // The resolver reads flag state from the gateway-populated override cache
    // and ignores the config argument; pass the read-only config for signature
    // parity without mutating disk before the reconcile decision is made.
    const enabled = isAssistantFeatureFlagEnabled(
      gated.flagKey,
      getConfigReadOnly(),
    );

    const profileChanged = enabled
      ? enableProfile(gated, profiles, profileOrder, previous, isByokMode)
      : disableProfile(gated, llm, profiles, profileOrder, previous);

    if (profileChanged) {
      log.info(
        { profile: gated.profileKey, enabled },
        "Reconciled flag-gated profile",
      );
    }
    changed = changed || profileChanged;
  }

  if (changed) {
    saveRawConfig(config);
    invalidateConfigCache();
  }
  return changed;
}

function enableProfile(
  gated: FlagGatedProfile,
  profiles: Record<string, Record<string, unknown>>,
  profileOrder: string[],
  previous: Record<string, unknown> | null,
  isByokMode: boolean,
): boolean {
  const { template } = gated;
  const effectiveTemplate = isByokMode
    ? { ...template, label: `${template.label} (Managed)` }
    : template;
  const next = materializeProfile(
    effectiveTemplate,
    template.provider,
    template.connectionName,
  ) as Record<string, unknown>;

  // BYOK installs seed managed profiles disabled: the platform-auth
  // `fireworks-managed` connection backing this profile isn't usable until the
  // user enables it, so a fresh managed entry starts disabled to avoid offering
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
    profiles[gated.profileKey] = next as ProfileEntry;
    changed = true;
  }

  if (!profileOrder.includes(gated.profileKey)) {
    const balancedIndex = profileOrder.indexOf("balanced");
    if (balancedIndex >= 0) {
      profileOrder.splice(balancedIndex + 1, 0, gated.profileKey);
    } else {
      profileOrder.push(gated.profileKey);
    }
    changed = true;
  }

  return changed;
}

// `MixSchema = z.array(MixArmSchema).min(2)` in schemas/llm.ts: mixes require
// >= 2 arms. A mix that drops below this is invalid and cannot be kept.
const MIX_MIN_ARMS = 2;

function disableProfile(
  gated: FlagGatedProfile,
  llm: Record<string, unknown>,
  profiles: Record<string, Record<string, unknown>>,
  profileOrder: string[],
  previous: Record<string, unknown> | null,
): boolean {
  if (!previous) return false;

  delete profiles[gated.profileKey];

  // The removal closure: every name here is absent from `profiles` once the
  // closure settles, so the written config can never reference one. A mix that
  // loses arms below the >= 2 minimum is itself invalid, so it joins the set
  // and the loop runs to a fixpoint to resolve any references that cascade.
  const removed = new Set<string>([gated.profileKey]);
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

  // Filter in place so `llm.profileOrder` and the caller's `profileOrder` are
  // the same array reference across the reconcile loop: each removal sees the
  // previous removal's result, so removing both gated profiles in one pass (both
  // present, both flags off) leaves neither name in the order.
  const survivors = profileOrder.filter((name) => !removed.has(name));
  profileOrder.length = 0;
  profileOrder.push(...survivors);

  if (typeof llm.activeProfile === "string" && removed.has(llm.activeProfile)) {
    llm.activeProfile = "balanced";
  }
  if (
    typeof llm.advisorProfile === "string" &&
    removed.has(llm.advisorProfile)
  ) {
    if (readObject(profiles["quality-optimized"]) !== null) {
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
