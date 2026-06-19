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
  materializeProfile,
  OS_BETA_FEATURE_FLAG_KEY,
  OS_BETA_PROFILE_KEY,
  OS_BETA_PROFILE_TEMPLATE,
  readObject,
} from "./seed-inference-profiles.js";

const log = getLogger("sync-gated-profiles");

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

function disableProfile(
  llm: Record<string, unknown>,
  profiles: Record<string, Record<string, unknown>>,
  profileOrder: string[],
  previous: Record<string, unknown> | null,
): boolean {
  if (!previous) return false;

  delete profiles[OS_BETA_PROFILE_KEY];

  const orderIndex = profileOrder.indexOf(OS_BETA_PROFILE_KEY);
  if (orderIndex >= 0) profileOrder.splice(orderIndex, 1);

  if (llm.activeProfile === OS_BETA_PROFILE_KEY) {
    llm.activeProfile = "balanced";
  }
  if (llm.advisorProfile === OS_BETA_PROFILE_KEY) {
    if (readObject(profiles["quality-optimized"]) !== null) {
      llm.advisorProfile = "quality-optimized";
    } else {
      delete llm.advisorProfile;
    }
  }

  // Removing a flag-gated profile also drops it from any user mix arms so the
  // config stays loadable — `LLMSchema.superRefine` rejects a mix arm naming a
  // missing profile.
  for (const profile of Object.values(profiles)) {
    if (!Array.isArray(profile.mix)) continue;
    const arms = profile.mix as Array<Record<string, unknown>>;
    const kept = arms.filter(
      (arm) => readObject(arm)?.profile !== OS_BETA_PROFILE_KEY,
    );
    if (kept.length !== arms.length) {
      profile.mix = kept;
    }
  }

  return true;
}
