import { isDeepStrictEqual } from "node:util";

import { getLogger } from "../util/logger.js";
import { isAssistantFeatureFlagEnabled } from "./assistant-feature-flags.js";
import {
  AUTO_PROFILE_TEMPLATE,
  type DefaultProfileTemplate,
  OS_BETA_PROFILE_TEMPLATE,
} from "./default-profile-catalog.js";
import {
  AUTO_PROFILE_FEATURE_FLAG_KEY,
  AUTO_PROFILE_KEY,
  OS_BETA_PROFILE_KEY,
} from "./default-profile-names.js";
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

interface GatedProfile {
  key: string;
  flag: string;
  template: DefaultProfileTemplate;
  /** Insert the key into a `profileOrder` that does not yet list it. */
  place: (profileOrder: string[]) => void;
  /**
   * Whether a BYOK install first materializes the stub disabled. True for a
   * profile whose managed route exists but is unusable until the user enables
   * the managed connection; false for a managed-only profile, whose stub has
   * no body on a BYOK column and so is never offered there anyway.
   */
  byokStartsDisabled: boolean;
}

const GATED_PROFILES: readonly GatedProfile[] = [
  {
    key: OS_BETA_PROFILE_KEY,
    flag: OS_BETA_FEATURE_FLAG_KEY,
    template: OS_BETA_PROFILE_TEMPLATE,
    place: (profileOrder) => {
      const balancedIndex = profileOrder.indexOf("balanced");
      if (balancedIndex >= 0) {
        profileOrder.splice(balancedIndex + 1, 0, OS_BETA_PROFILE_KEY);
      } else {
        profileOrder.push(OS_BETA_PROFILE_KEY);
      }
    },
    byokStartsDisabled: true,
  },
  {
    key: AUTO_PROFILE_KEY,
    flag: AUTO_PROFILE_FEATURE_FLAG_KEY,
    template: AUTO_PROFILE_TEMPLATE,
    // Auto leads the picker.
    place: (profileOrder) => profileOrder.unshift(AUTO_PROFILE_KEY),
    byokStartsDisabled: false,
  },
];

/**
 * Reconcile flag-gated managed profiles against the current feature-flag state.
 *
 * `seedInferenceProfiles()` runs synchronously at boot before feature flags are
 * available, so the gated profiles (OS Beta, Auto) are materialized here once
 * flags have loaded. When a profile's flag is on, its managed stub is created
 * and placed in `profileOrder`; when it is off, a previously managed entry is
 * removed with `profileOrder` / `activeProfile` / `advisorProfile` / call-site
 * fallbacks. The reconcile is idempotent and never touches a user-owned
 * profile of the same name.
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
  for (const gated of GATED_PROFILES) {
    // The resolver reads flag state from the gateway-populated override cache
    // and ignores the config argument; pass the read-only config for signature
    // parity without mutating disk before the reconcile decision is made.
    const enabled = isAssistantFeatureFlagEnabled(
      gated.flag,
      getConfigReadOnly(),
    );

    const previous = readObject(profiles[gated.key]);

    // Never clobber a user-owned profile that happens to share the name. The
    // entry is ours to manage only when it is absent or already managed; a
    // user-sourced entry of the same name is left untouched on every path.
    const isOursToManage = previous == null || previous.source === "managed";
    if (!isOursToManage) {
      continue;
    }

    const order = llm.profileOrder as string[];
    const profileChanged = enabled
      ? enableProfile(gated, profiles, order, previous, isByokMode)
      : disableProfile(gated.key, llm, profiles, order, previous);
    if (profileChanged) {
      changed = true;
      log.info(
        { profile: gated.key, enabled },
        "Reconciled flag-gated profile",
      );
    }
  }

  if (changed) {
    saveRawConfig(config);
    invalidateConfigCache();
  }
  return changed;
}

function enableProfile(
  gated: GatedProfile,
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
  // entry starts disabled to avoid offering an unusable route. The
  // " (Managed)" label suffix disambiguates it from personal profiles in
  // pickers. A user's own overrides (preserved below) win on later
  // reconciles.
  if (gated.byokStartsDisabled && isByokMode && !previous) {
    next.status = "disabled";
    next.label = `${gated.template.label} (Managed)`;
  }

  if (previous) {
    // Preserve user-owned overrides across reconciles.
    if ("label" in previous) {
      next.label = previous.label;
    }
    if ("status" in previous) {
      next.status = previous.status;
    }
    if ("topP" in previous) {
      next.topP = previous.topP;
    }
  }

  let changed = false;
  if (!previous || !isDeepStrictEqual(previous, next)) {
    profiles[gated.key] = next as ProfileEntry;
    changed = true;
  }

  if (!profileOrder.includes(gated.key)) {
    gated.place(profileOrder);
    changed = true;
  }

  return changed;
}

// `MixSchema = z.array(MixArmSchema).min(2)` in schemas/llm.ts: mixes require
// >= 2 arms. A mix that drops below this is invalid and cannot be kept.
const MIX_MIN_ARMS = 2;

function disableProfile(
  key: string,
  llm: Record<string, unknown>,
  profiles: Record<string, Record<string, unknown>>,
  profileOrder: string[],
  previous: Record<string, unknown> | null,
): boolean {
  if (!previous) {
    return false;
  }

  delete profiles[key];

  // The removal closure: every name here is absent from `profiles` once the
  // closure settles, so the written config can never reference one. A mix that
  // loses arms below the >= 2 minimum is itself invalid, so it joins the set
  // and the loop runs to a fixpoint to resolve any references that cascade.
  const removed = new Set<string>([key]);
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
