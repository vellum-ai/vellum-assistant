import { isDeepStrictEqual } from "node:util";

import { getLogger } from "../util/logger.js";
import { isAssistantFeatureFlagEnabled } from "./assistant-feature-flags.js";
import { OS_BETA_PROFILE_TEMPLATE } from "./default-profile-catalog.js";
import { OS_BETA_PROFILE_KEY } from "./default-profile-names.js";
import {
  getConfigReadOnly,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "./loader.js";
import type { ProfileEntry } from "./schemas/llm.js";
import {
  OS_BETA_FEATURE_FLAG_KEY,
  readObject,
} from "./seed-inference-profiles.js";

const log = getLogger("sync-gated-profiles");

/**
 * Reconcile flag-gated managed profiles against the current feature-flag state.
 *
 * `seedInferenceProfiles()` runs synchronously at boot before feature flags are
 * available, so the OS Beta profile (MiniMax M3 / together-managed) is
 * materialized here once flags have loaded. When the `os-beta` flag is on, the
 * managed profile is created (ordered right after `balanced`); when it is off, a
 * previously managed entry is removed with `profileOrder` / `activeProfile` /
 * `advisorProfile` fallbacks. The reconcile is idempotent and never touches a
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
  const isOursToManage = previous == null || previous.source === "managed";
  if (!isOursToManage) {
    return false;
  }

  const changed = enabled
    ? enableProfile(profiles, profileOrder, previous, isByokMode)
    : disableProfile(llm, profiles, profileOrder, previous);

  if (changed) {
    saveRawConfig(config);
    invalidateConfigCache();
    log.info(
      { profile: OS_BETA_PROFILE_KEY, enabled },
      "Reconciled flag-gated profile",
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
  // The profile's content is code-owned (`default-profile-catalog.ts`) and
  // resolves through the effective view once this stub exists; the workspace
  // entry carries only the overlay fields (`source`, `label`, `status`,
  // `topP`).
  const next: Record<string, unknown> = { source: "managed" };

  // BYOK installs create the stub disabled: the managed inference connection
  // backing this profile isn't usable until the user enables it, so a fresh
  // OS Beta entry starts disabled to avoid offering an unusable route. The
  // " (Managed)" label suffix disambiguates it from personal profiles in
  // pickers. A user's own overrides (preserved below) win on later
  // reconciles.
  if (isByokMode && !previous) {
    next.status = "disabled";
    next.label = `${OS_BETA_PROFILE_TEMPLATE.label} (Managed)`;
  }

  if (previous) {
    // Preserve user-owned overrides across reconciles.
    if ("label" in previous) next.label = previous.label;
    if ("status" in previous) next.status = previous.status;
    if ("topP" in previous) next.topP = previous.topP;
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
    // Repoint the advisor at the managed Quality profile (the strongest).
    // `quality-optimized` is an always-available code-catalog default, so it
    // resolves whether or not a workspace stub exists.
    llm.advisorProfile = "quality-optimized";
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
