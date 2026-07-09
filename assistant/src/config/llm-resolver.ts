import { z } from "zod";

import {
  getCatalogProviderForModel,
  isModelInCatalog,
} from "../providers/model-catalog.js";
import {
  MANAGED_ROUTABLE_PROVIDERS,
  VELLUM_MANAGED_CONNECTION_NAME,
} from "../providers/vellum-model-routing.js";
import { isAssistantFeatureFlagEnabled } from "./assistant-feature-flags.js";
import { CALL_SITE_DEFAULTS } from "./call-site-defaults.js";
import {
  getEffectiveProfile,
  resolveDefaultProfileForProvider,
} from "./default-profile-catalog.js";
import {
  type LLMCallSite,
  LLMConfigBase,
  type LLMSchema,
  type ProfileEntry,
} from "./schemas/llm.js";

/**
 * Resolves a fully-specified `LLMConfigBase` for a given call site by layering
 * call-site overrides, optional per-call profile, an optional ad-hoc override
 * profile, the workspace's active profile, and the required `llm.default`.
 *
 * Merge layers (low → high precedence; later layers override earlier) for
 * non-main-agent call sites:
 *   1. `llm.default` fields (required base)
 *   2. `llm.profiles[llm.activeProfile]` (workspace-wide active profile) —
 *      folded in ONLY when the call site resolves no profile of its own (a
 *      profile-less leaf like `vision`/`workflowLeaf`, or a BYOK install whose
 *      pinned managed profile was stripped). When the call site resolves a
 *      profile, that profile is the authoritative provider config and the
 *      active profile does not contribute — otherwise a deep-merge would let
 *      its orphan fields bleed onto a different provider.
 *   3. `llm.profiles[opts.overrideProfile]` (per-call ad-hoc override)
 *   4. `llm.profiles[site.profile]` fields (call-site's named profile)
 *   5. `llm.callSites[callSite]` fields (call-site override)
 *
 * For `mainAgent`, the selected active/conversation profile is the direct
 * user intent for the chat loop, so profile layers intentionally sit above
 * any static `llm.callSites.mainAgent` defaults seeded by migrations or UI
 * settings:
 *   1. `llm.default`
 *   2. `llm.profiles[site.profile]`
 *   3. `llm.callSites.mainAgent`
 *   4. `llm.profiles[llm.activeProfile]`
 *   5. `llm.profiles[opts.overrideProfile]`
 *
 * `opts.forceOverrideProfile` is an explicit escape hatch for non-main-agent
 * call sites: when true (and `opts.overrideProfile` resolves to a defined
 * profile), the override profile floats ABOVE the call-site layers — the
 * non-main ordering becomes default → activeProfile → site profile →
 * call-site override → overrideProfile. This mirrors how `mainAgent` treats
 * the user's chat-model selection as authoritative, and exists for callers
 * that must run a background call site under a specific conversation's
 * inference profile (e.g. fork-based memory retrospectives matching the
 * source conversation for provider prompt-cache reuse). When the referenced
 * profile is missing, the flag is inert and the normal precedence applies
 * (same silent fall-through as any `overrideProfile` reference); for
 * `mainAgent` the flag is a no-op because the override already sits on top.
 *
 * Nested objects (`thinking`, `contextWindow`, and
 * `contextWindow.overflowRecovery`) are deep-merged so partial overrides at
 * any nesting level merge into — rather than replace — the corresponding
 * base value.
 *
 * `temperature` and `top_p` are provider-coupled, so they do NOT deep-merge
 * field-by-field with the rest of the config: only the winning profile (the
 * highest-precedence profile that determines provider/model) contributes them,
 * and an explicit `llm.callSites[callSite]` override still wins. A lower-
 * precedence profile whose model is shadowed never leaks its sampling onto a
 * different provider (which would trip e.g. Anthropic's "temperature and top_p
 * cannot both be specified" constraint). `logitBias` is winning-profile-scoped
 * the same way.
 *
 * `activeProfile` and `overrideProfile` are resolved by name lookup against
 * the effective profile catalog (code-defined defaults + workspace
 * `llm.profiles`; see `getEffectiveProfile`). Missing references silently
 * fall through (no throw) so the
 * resolver stays pure; schema validation in `LLMSchema.superRefine` catches
 * unknown `activeProfile` references at config-load time.
 *
 * A profile reference that points at a "mix" profile is expanded to one of its
 * constituent profiles by a seeded weighted pick (see `resolveProfileFragment`
 * and `opts.selectionSeed`). Expansion happens uniformly at every dereference
 * spot, so a mix works as `activeProfile`, `overrideProfile`, or a call-site
 * `profile`.
 *
 * Pure & synchronous: no I/O, no async work. (Random selection only occurs for
 * mix profiles when no `selectionSeed` is supplied; with a seed the pick is
 * deterministic.)
 */
export interface ResolveCallSiteOpts {
  overrideProfile?: string;
  /**
   * Float `overrideProfile` above the call-site layers (named site profile +
   * call-site override) for non-main-agent call sites. See the
   * `resolveCallSiteConfig` docstring for the resulting precedence and the
   * use case. Inert when `overrideProfile` is absent or references a missing
   * profile, and a no-op for `mainAgent`.
   */
  forceOverrideProfile?: boolean;
  /**
   * Per-conversation seed for expanding `mix` profiles. The chosen constituent
   * is a deterministic function of `selectionSeed` + the mix profile's own
   * name, so every `resolveCallSiteConfig` call for the same conversation picks
   * the SAME arm (stable across turns, retries, and restarts). Pass the
   * conversation id. When absent, the resolver falls back to a fresh random
   * pick per call — acceptable only for one-shot/background call sites that
   * resolve config exactly once per invocation.
   */
  selectionSeed?: string;
  /**
   * Invoked once for each mix profile the resolver expands, reporting which
   * constituent was chosen. Used by A/B-eval recording (usage attribution).
   */
  onMixSelected?: (info: { mixProfile: string; chosenProfile: string }) => void;
  /**
   * Override-or-default semantics only: invoked once per chain rung that
   * named a profile the resolver could not use, before resolution continues
   * to the next rung. Fallback is silent to the call but must be visible in
   * logs — callers on user-facing paths should log at warn.
   */
  onResolutionFallback?: (info: {
    callSite: LLMCallSite;
    requested: string;
    reason: ResolutionFallbackReason;
  }) => void;
  /**
   * Test/caller override for the resolution semantics. When absent, the
   * `override-or-default-resolution` feature flag decides (ships enabled;
   * disabling it is the kill switch back to the legacy merge cascade).
   */
  resolutionSemantics?: "override-or-default" | "legacy-merge";
}

export type ResolutionFallbackReason = "missing" | "disabled" | "incomplete";

export const OVERRIDE_OR_DEFAULT_RESOLUTION_FLAG =
  "override-or-default-resolution";

/**
 * The flag read ignores its config argument (the override cache and registry
 * are module state), so the resolver stays call-site-compatible without
 * threading `AssistantConfig` through every consumer.
 */
export function isOverrideOrDefaultResolutionEnabled(): boolean {
  return isAssistantFeatureFlagEnabled(
    OVERRIDE_OR_DEFAULT_RESOLUTION_FLAG,
    undefined as never,
  );
}

function useOverrideOrDefaultSemantics(opts: ResolveCallSiteOpts): boolean {
  if (opts.resolutionSemantics != null) {
    return opts.resolutionSemantics === "override-or-default";
  }
  return isOverrideOrDefaultResolutionEnabled();
}

export function resolveCallSiteConfig(
  callSite: LLMCallSite,
  llm: z.infer<typeof LLMSchema>,
  opts: ResolveCallSiteOpts = {},
): z.infer<typeof LLMConfigBase> {
  if (useOverrideOrDefaultSemantics(opts)) {
    return resolveOverrideOrDefault(callSite, llm, opts);
  }
  const layers: Mergeable[] = [llm.default as Mergeable];

  // Effective logit-bias preset, tracked outside the deep-merge so it ties to
  // the single highest-precedence *profile* that wins resolution rather than
  // inheriting from a lower one. Profile layers are appended low→high, and each
  // one fully determines the preset (a profile that omits `logitBias` clears
  // any value a lower-precedence profile set), so the last profile appended
  // wins — matching the merge's own precedence and including the implicit
  // call-site default selected by `effectiveDefault`.
  const biasRef: LogitBiasRef = { preset: undefined };

  // Effective sampling params, tracked outside the deep-merge for the same
  // reason as `logitBias`: `temperature`/`top_p` are provider-coupled, so only
  // the winning profile may contribute them. A profile clears what a lower
  // PROFILE set where it is silent (so a shadowed profile's sampling can't
  // leak), while an explicit call-site override is sticky and survives a later
  // silent profile (see `applyProfileSampling` / `appendCallSiteLayers`).
  const samplingRef: SamplingRef = {
    temperature: undefined,
    topP: undefined,
    temperatureFromCallSite: false,
    topPFromCallSite: false,
  };

  const activeFragment = resolveProfileFragment(llm.activeProfile, llm, opts);
  const overrideFragment = resolveProfileFragment(
    opts.overrideProfile,
    llm,
    opts,
  );
  const site =
    llm.callSites?.[callSite] ??
    effectiveDefault(callSite, llm, opts.overrideProfile != null);

  if (callSite === "mainAgent") {
    appendCallSiteLayers(
      layers,
      callSite,
      llm,
      site,
      opts,
      biasRef,
      samplingRef,
    );
    appendProfileLayer(layers, activeFragment, biasRef, samplingRef);
    appendProfileLayer(layers, overrideFragment, biasRef, samplingRef);
  } else if (opts.forceOverrideProfile === true && overrideFragment != null) {
    // Escape hatch: float the override profile above the call-site layers,
    // mirroring mainAgent's treatment of the user's chat-model selection.
    // Guarded on a resolved fragment so a missing profile reference degrades
    // to the normal precedence below instead of silently dropping the
    // call-site layers' standing. The active profile stays the bottom fallback
    // (its sampling can't leak — a higher profile's REPLACE clears it).
    appendProfileLayer(layers, activeFragment, biasRef, samplingRef);
    appendCallSiteLayers(
      layers,
      callSite,
      llm,
      site,
      opts,
      biasRef,
      samplingRef,
    );
    appendProfileLayer(layers, overrideFragment, biasRef, samplingRef);
  } else {
    // The active profile is a low-precedence FALLBACK for call sites that
    // resolve no profile of their own — profile-less leaves (`vision`,
    // `workflowLeaf`) and BYOK installs where the pinned managed profile was
    // stripped. When the call site DOES resolve its own profile, that profile
    // is the authoritative provider config, so the active profile must not
    // contribute its orphan fields to a different provider.
    if (site?.profile == null) {
      appendProfileLayer(layers, activeFragment, biasRef, samplingRef);
    }
    appendProfileLayer(layers, overrideFragment, biasRef, samplingRef);
    appendCallSiteLayers(
      layers,
      callSite,
      llm,
      site,
      opts,
      biasRef,
      samplingRef,
    );
  }

  const resolved = finalize(deepMerge(...withImpliedProviders(layers)));
  // `logitBias` is profile-scoped: the winning profile is its only source.
  // Overwrite — or clear — whatever the deep-merge may have copied from a
  // non-profile layer (`llm.default` or a call-site fragment), so a preset set
  // outside a profile can't apply to a profile that didn't opt in.
  if (biasRef.preset !== undefined) {
    resolved.logitBias = biasRef.preset;
  } else {
    delete (resolved as { logitBias?: unknown }).logitBias;
  }
  // `temperature`/`top_p` are winning-profile-scoped like `logitBias`, but an
  // explicit call-site override may also set them. Apply the tracked value,
  // overriding whatever a shadowed profile may have left in the merge. An
  // `undefined` ref means no profile or override opted in, so the `llm.default`
  // base already in `resolved` stands.
  if (samplingRef.temperature !== undefined) {
    resolved.temperature = samplingRef.temperature;
  }
  if (samplingRef.topP !== undefined) {
    resolved.topP = samplingRef.topP;
  }
  return resolved;
}

// ─── Override-or-default resolution (flag-on path) ──────────────────────────
//
// Selection is a single-winner chain — each rung is either a complete
// explicit choice or skipped with a reported reason — bottoming out on the
// code-owned default intent resolved through `llm.defaultProvider`:
//   1. `opts.overrideProfile` (conversation/schedule/per-turn pin)
//   2. `llm.activeProfile` (mainAgent only — it IS that call site's selection)
//   3. `llm.callSites[callSite].profile`
//   4. `CALL_SITE_DEFAULTS[callSite].profile` intent × default provider
//   5. balanced intent × default provider (profileless sites, or nothing
//      above usable)
// A winner must carry its own `provider` AND `model`: the base layer's
// schema-default identity must never stand in for a selected profile (that
// would be merge inheritance by the back door). The legacy `custom-${intent}`
// hop is deliberately absent — a fallback anchor must be code-owned, never
// user-mutable state.
//
// The request config is the base + winner + site-tweak composition:
// code-owned schema defaults, then the single winning profile, then the call
// site's own tuning fragment. Selection is pure either/or — no profile ever
// contributes a field to another profile; `deepMerge` here only makes nested
// tweaks (`thinking.enabled`) combine leaf-wise instead of wiping siblings.
// `temperature`/`topP` come from the winner (or an explicit tweak);
// `logitBias` only ever from the winner.
// `forceOverrideProfile` is a no-op here (the override is already first).

export interface ProfileWinnerSelection {
  /** Named winner (a mix's own name, not its arm); null → the anchor rung. */
  profileName: string | null;
  source: "override" | "active" | "call_site" | "default";
  /** The concrete (mix-expanded) entry that won; null only if even the code
   * catalog was unusable, which the load-time catalog validation prevents. */
  entry: ProfileEntry | null;
}

export function selectWinningProfile(
  callSite: LLMCallSite,
  llm: z.infer<typeof LLMSchema>,
  opts: ResolveCallSiteOpts = {},
): ProfileWinnerSelection {
  const report = (requested: string, reason: ResolutionFallbackReason) =>
    opts.onResolutionFallback?.({ callSite, requested, reason });

  const override = usableEntry(opts.overrideProfile, llm, opts, report);
  if (override) {
    return {
      profileName: override.name,
      source: "override",
      entry: override.entry,
    };
  }
  if (callSite === "mainAgent") {
    const active = usableEntry(llm.activeProfile, llm, opts, report);
    if (active) {
      return {
        profileName: active.name,
        source: "active",
        entry: active.entry,
      };
    }
  }
  const sitePin = usableEntry(
    llm.callSites?.[callSite]?.profile,
    llm,
    opts,
    report,
  );
  if (sitePin) {
    return {
      profileName: sitePin.name,
      source: "call_site",
      entry: sitePin.entry,
    };
  }
  const intent = CALL_SITE_DEFAULTS[callSite]?.profile;
  if (intent != null) {
    const entry = usableDefaultIntent(intent, llm, opts, report);
    if (entry) {
      return { profileName: intent, source: "default", entry };
    }
  }
  // Anchor: profileless call sites (`vision`, `workflowLeaf`) and any
  // resolution whose every named rung was unusable land on balanced intent
  // through the default provider. `profileName` stays null — the anchor is
  // not a selection.
  return {
    profileName: null,
    source: "default",
    entry: usableDefaultIntent("balanced", llm, opts, report) ?? null,
  };
}

/**
 * Dereference a named rung: the effective entry must exist, be enabled,
 * expand (for a mix) to an enabled arm, and carry its own provider+model.
 */
function usableEntry(
  name: string | undefined,
  llm: z.infer<typeof LLMSchema>,
  opts: ResolveCallSiteOpts,
  report: (requested: string, reason: ResolutionFallbackReason) => void,
): { name: string; entry: ProfileEntry } | undefined {
  if (name == null) {
    return undefined;
  }
  const named = getEffectiveProfile(llm.profiles, name);
  if (named == null) {
    report(name, "missing");
    return undefined;
  }
  if (named.status === "disabled") {
    report(name, "disabled");
    return undefined;
  }
  // Mixes expand via the shared seeded pick (fires `onMixSelected`).
  const entry =
    named.mix == null ? named : resolveProfileFragment(name, llm, opts);
  if (entry == null) {
    report(name, "missing");
    return undefined;
  }
  if (entry.status === "disabled") {
    report(name, "disabled");
    return undefined;
  }
  if (entry.provider == null || entry.model == null) {
    report(name, "incomplete");
    return undefined;
  }
  return { name, entry };
}

/**
 * Resolve a default-profile intent through the default provider. A user
 * shadow that is unusable (disabled/incomplete/a broken mix) is reported and
 * the pure catalog body stands — the fallback anchor is code-owned and must
 * always resolve. A legacy disabled stub on a default is likewise reported
 * and overridden: defaults cannot be disabled through any write path, so a
 * persisted disabled stub is stale hatch-era state whose meaning ("no vellum
 * connection") `llm.defaultProvider` expresses properly.
 */
function usableDefaultIntent(
  intent: string,
  llm: z.infer<typeof LLMSchema>,
  opts: ResolveCallSiteOpts,
  report: (requested: string, reason: ResolutionFallbackReason) => void,
): ProfileEntry | undefined {
  const defaultProvider = llm.defaultProvider ?? null;
  let entry = resolveDefaultProfileForProvider(
    llm.profiles,
    intent,
    defaultProvider,
  );
  if (entry?.mix != null) {
    entry = resolveProfileFragment(intent, llm, opts);
  }
  if (
    entry != null &&
    entry.status !== "disabled" &&
    entry.provider != null &&
    entry.model != null
  ) {
    return entry;
  }
  if (entry == null) {
    report(intent, "missing");
  } else {
    report(intent, entry.status === "disabled" ? "disabled" : "incomplete");
  }
  const catalog = resolveDefaultProfileForProvider(
    undefined,
    intent,
    defaultProvider,
  );
  if (catalog != null && catalog.provider != null && catalog.model != null) {
    return catalog;
  }
  return undefined;
}

/**
 * Schema-default base for composition. Non-identity fields a winner omits
 * fall to these code-owned defaults (never to `llm.default`); the winner's
 * identity fields are guaranteed present by `selectWinningProfile`.
 */
const CODE_DEFAULT_BASE: z.infer<typeof LLMConfigBase> = LLMConfigBase.parse(
  {},
);

function resolveOverrideOrDefault(
  callSite: LLMCallSite,
  llm: z.infer<typeof LLMSchema>,
  opts: ResolveCallSiteOpts,
): z.infer<typeof LLMConfigBase> {
  const selection = selectWinningProfile(callSite, llm, opts);
  const winnerFragment: Mergeable =
    selection.entry == null ? {} : winnerConfigFragment(selection.entry);

  // The call site's own tweak fragment: the workspace override replaces the
  // code default wholesale (matching legacy `llm.callSites[site] ??
  // CALL_SITE_DEFAULTS[site]`). `profile` is the selection discriminator and
  // `logitBias` is winner-owned, so neither enters the merge.
  const site = llm.callSites?.[callSite] ?? CALL_SITE_DEFAULTS[callSite];
  const {
    profile: _siteProfile,
    logitBias: _siteBias,
    ...tweak
  } = (site ?? {}) as Record<string, unknown>;

  // Direct call-site model overrides are fragments by design: when the tweak
  // pins a model the winner's provider does not serve, stamp the catalog
  // owner and drop the winner's connection (it belongs to the replaced
  // provider; dispatch auto-resolves an absent connection by provider).
  const applicableProvider =
    (winnerFragment.provider as string | undefined) ??
    CODE_DEFAULT_BASE.provider;
  if (
    typeof tweak.model === "string" &&
    tweak.provider === undefined &&
    !isModelInCatalog(applicableProvider, tweak.model)
  ) {
    const implied = getCatalogProviderForModel(tweak.model);
    if (implied !== undefined) {
      tweak.provider = implied;
      // A provider-specific connection must not pin a mismatch onto the
      // implied provider — but the provider-agnostic Vellum managed
      // connection routes any managed-routable upstream and must survive,
      // or platform installs lose their only connection.
      if (
        !(
          winnerFragment.provider_connection ===
            VELLUM_MANAGED_CONNECTION_NAME &&
          MANAGED_ROUTABLE_PROVIDERS.has(implied)
        )
      ) {
        delete winnerFragment.provider_connection;
      }
    }
  }

  return finalize(
    deepMerge(CODE_DEFAULT_BASE as unknown as Mergeable, winnerFragment, tweak),
  );
}

/** The winner's config fields: metadata stripped, sampling and logitBias
 * kept — with a single winner there is no cross-profile leakage to guard. */
function winnerConfigFragment(entry: ProfileEntry): Mergeable {
  const {
    source: _source,
    label: _label,
    description: _description,
    status: _status,
    mix: _mix,
    ...config
  } = entry;
  return config as Mergeable;
}

type LogitBiasRef = { preset: ProfileEntry["logitBias"] };

type SamplingRef = {
  temperature: ProfileEntry["temperature"];
  topP: ProfileEntry["topP"];
  // Provenance of the current pair: `true` when a field came from an explicit
  // call-site override (deliberate, sticky), `false` when it came from a profile
  // (clearable by a higher-precedence profile that determines the model). Lets a
  // silent higher profile clear a lower profile's sampling without discarding a
  // deliberate call-site override.
  temperatureFromCallSite: boolean;
  topPFromCallSite: boolean;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type Mergeable = Record<string, unknown>;

/**
 * FNV-1a 32-bit string hash → unit float in [0, 1). Deterministic and stable
 * across runtimes — the mix-pick contract depends on identical output for
 * identical input forever, so the constants must never change. (Mirrors the
 * private hash in `memory/v2/page-index.ts`; intentionally re-declared here so
 * the resolver's determinism contract is self-contained and cannot be broken
 * by an unrelated edit to that module.)
 */
function seededUnitFloat(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // `>>> 0` → unsigned 32-bit; divide by 2^32 to land in [0, 1).
  return (h >>> 0) / 0x100000000;
}

/**
 * Pick one entry from a weighted list given a unit float in [0, 1). Weights
 * are relative and normalized by their sum. Assumes `entries` is non-empty
 * with positive weights (guaranteed by `MixSchema`: `.min(2)` + positive).
 */
function weightedPick<T extends { weight: number }>(
  entries: readonly T[],
  unit: number,
): T {
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  // Defensive: a degenerate total (unreachable post-schema) → first arm.
  if (!(total > 0)) return entries[0];
  let threshold = unit * total;
  for (const entry of entries) {
    threshold -= entry.weight;
    if (threshold < 0) return entry;
  }
  // Floating-point fall-through (unit ≈ 1): return the last arm.
  return entries[entries.length - 1];
}

/**
 * Dereference a profile name to its concrete `ProfileEntry`, expanding a mix
 * profile by a seeded weighted pick. Returns `undefined` when the name is
 * unknown (parity with the silent fall-through callers already rely on).
 *
 * Mix expansion is one level only — `LLMSchema.superRefine` guarantees arms
 * are standard (non-mix) profiles, so this never recurses unboundedly. A
 * chosen arm pointing at a missing profile (only reachable in hand-crafted,
 * unparsed configs) falls through to `undefined`.
 *
 * Pure & synchronous (the only impurity is `Math.random()` in the no-seed
 * fallback path).
 */
function resolveProfileFragment(
  name: string | undefined,
  llm: z.infer<typeof LLMSchema>,
  opts: ResolveCallSiteOpts,
): ProfileEntry | undefined {
  if (name == null) return undefined;
  const entry = getEffectiveProfile(llm.profiles, name);
  if (entry?.mix == null) return entry;

  // Mix: pick one constituent. Seed by per-conversation seed + the mix's own
  // name so two different mixes in the same conversation pick independently,
  // but the same mix always resolves to the same arm within the conversation.
  const unit =
    opts.selectionSeed != null
      ? seededUnitFloat(`${opts.selectionSeed}\u0000${name}`)
      : Math.random();
  const chosen = weightedPick(entry.mix, unit);
  opts.onMixSelected?.({ mixProfile: name, chosenProfile: chosen.profile });

  // The chosen arm must be a standard profile (enforced by superRefine).
  return getEffectiveProfile(llm.profiles, chosen.profile);
}

/**
 * Returns the effective default profile key the resolver would actually
 * select for a call site when no per-turn `overrideProfile` is supplied.
 *
 * Mirrors the layering in `resolveCallSiteConfig`:
 * - For `mainAgent`, the workspace's `activeProfile` sits ABOVE the
 *   call-site catalog default (and above any static `llm.callSites.mainAgent`
 *   override), so a non-disabled `activeProfile` wins.
 * - For other call sites, the catalog default sits ABOVE `activeProfile`,
 *   so the catalog default (with `custom-*` fallback) wins.
 */
export function resolveDefaultProfileKey(
  callSite: LLMCallSite,
  llm: z.infer<typeof LLMSchema>,
): string | undefined {
  if (useOverrideOrDefaultSemantics({})) {
    return selectWinningProfile(callSite, llm, {}).profileName ?? undefined;
  }
  if (callSite === "mainAgent" && llm.activeProfile != null) {
    const active = getEffectiveProfile(llm.profiles, llm.activeProfile);
    if (active != null && active.status !== "disabled") {
      return llm.activeProfile;
    }
  }

  const dflt = CALL_SITE_DEFAULTS[callSite];
  if (dflt?.profile == null) return undefined;
  const target = getEffectiveProfile(llm.profiles, dflt.profile);
  if (target != null && target.status !== "disabled") return dflt.profile;
  const customKey = `custom-${dflt.profile}`;
  const customTarget = getEffectiveProfile(llm.profiles, customKey);
  if (customTarget != null && customTarget.status !== "disabled")
    return customKey;
  return undefined;
}

/**
 * Returns the profile key that `resolveCallSiteConfig` would actually treat as
 * the winning (highest-precedence) profile for a turn — the profile whose
 * fragment supplies the resolved provider/model. Unlike `resolveDefaultProfileKey`
 * this accounts for the per-turn `overrideProfile`/`forceOverrideProfile` and
 * for `effectiveDefault` stripping the catalog default when an override is
 * present, so error attribution names the slot the resolver really used:
 * - `mainAgent`: override → active → catalog default.
 * - forced override: the override.
 * - other sites: the call-site's own profile (explicit or catalog default) when
 *   one survives; otherwise override → active. A pinned override on a bare call
 *   site therefore attributes to the override, not the stripped catalog default.
 */
export function resolveEffectiveProfileKey(
  callSite: LLMCallSite,
  llm: z.infer<typeof LLMSchema>,
  opts: ResolveCallSiteOpts = {},
): string | undefined {
  const override = opts.overrideProfile ?? undefined;
  if (callSite === "mainAgent") {
    return override ?? resolveDefaultProfileKey(callSite, llm);
  }
  if (opts.forceOverrideProfile === true && override != null) {
    return override;
  }
  const site =
    llm.callSites?.[callSite] ??
    effectiveDefault(callSite, llm, override != null);
  if (site?.profile != null) return site.profile;
  return override ?? llm.activeProfile ?? undefined;
}

/**
 * Stable non-null identity for profileless configs. Callers should prefer real
 * profile keys first; when no named profile applies, the resolved model id is
 * the only model-selection identifier available.
 */
export function resolveProfilelessModelKey(
  callSite: LLMCallSite,
  llm: z.infer<typeof LLMSchema>,
  opts: ResolveCallSiteOpts = {},
): string {
  try {
    return resolveCallSiteConfig(callSite, llm, opts).model;
  } catch {
    return llm.default?.model ?? "default";
  }
}

function effectiveDefault(
  callSite: LLMCallSite,
  llm: z.infer<typeof LLMSchema>,
  hasOverrideProfile = false,
): z.infer<typeof LLMSchema>["callSites"][LLMCallSite] | undefined {
  const dflt = CALL_SITE_DEFAULTS[callSite];
  if (dflt == null) return undefined;
  const targetProfile =
    dflt.profile != null
      ? getEffectiveProfile(llm.profiles, dflt.profile)
      : undefined;
  const profileUnavailable =
    dflt.profile != null &&
    (targetProfile == null || targetProfile.status === "disabled");

  if (profileUnavailable && !hasOverrideProfile) {
    const customKey = `custom-${dflt.profile}`;
    const customProfile = getEffectiveProfile(llm.profiles, customKey);
    if (customProfile != null && customProfile.status !== "disabled") {
      return { ...dflt, profile: customKey };
    }
  }

  const stripProfile = hasOverrideProfile || profileUnavailable;
  if (stripProfile) {
    const { profile: _profile, ...rest } = dflt;
    return Object.keys(rest).length > 0 ? rest : undefined;
  }
  return dflt;
}

/**
 * Stamp a catalog-implied provider onto model-only layers whose model the
 * provider applicable at that point in the merge does not serve. Layers are
 * scanned in merge order (low → high precedence), tracking the provider the
 * merged config would carry at each layer: when that provider already lists
 * the layer's model in its own catalog, no implication is needed and the
 * layer stays provider-less so the lower-precedence provider wins. Models
 * unknown to the catalog never imply a provider.
 */
function withImpliedProviders(layers: Mergeable[]): Mergeable[] {
  let applicableProvider: string | undefined;
  return layers.map((layer) => {
    if (layer.provider !== undefined) {
      if (typeof layer.provider === "string") {
        applicableProvider = layer.provider;
      }
      return layer;
    }
    const model = layer.model;
    if (typeof model !== "string" || model.length === 0) {
      return layer;
    }
    if (
      applicableProvider !== undefined &&
      isModelInCatalog(applicableProvider, model)
    ) {
      return layer;
    }
    const provider = getCatalogProviderForModel(model);
    if (provider === undefined) {
      return layer;
    }
    applicableProvider = provider;
    return { ...layer, provider };
  });
}

/**
 * Fold a profile's sampling into `samplingRef`. A profile determines
 * provider/model, so its pair supersedes any LOWER PROFILE's: set each field the
 * profile specifies, and clear a lower profile's value where the profile is
 * silent. A deliberate call-site override is NOT a profile and outranks a silent
 * profile — it survives until a profile EXPLICITLY sets the field. (The mirror
 * COALESCE for call-site overrides lives in `appendCallSiteLayers`.)
 */
function applyProfileSampling(
  samplingRef: SamplingRef,
  profile: ProfileEntry,
): void {
  if (profile.temperature !== undefined) {
    samplingRef.temperature = profile.temperature;
    samplingRef.temperatureFromCallSite = false;
  } else if (!samplingRef.temperatureFromCallSite) {
    samplingRef.temperature = undefined;
  }
  if (profile.topP !== undefined) {
    samplingRef.topP = profile.topP;
    samplingRef.topPFromCallSite = false;
  } else if (!samplingRef.topPFromCallSite) {
    samplingRef.topP = undefined;
  }
}

function appendProfileLayer(
  layers: Mergeable[],
  profile: ProfileEntry | undefined,
  biasRef: LogitBiasRef,
  samplingRef: SamplingRef,
): void {
  if (profile != null) {
    biasRef.preset = profile.logitBias;
    applyProfileSampling(samplingRef, profile);
    layers.push(profileConfigFragment(profile));
  }
}

function appendCallSiteLayers(
  layers: Mergeable[],
  callSite: LLMCallSite,
  llm: z.infer<typeof LLMSchema>,
  site: z.infer<typeof LLMSchema>["callSites"][LLMCallSite] | undefined,
  opts: ResolveCallSiteOpts,
  biasRef: LogitBiasRef,
  samplingRef: SamplingRef,
): void {
  if (site != null) {
    if (site.profile != null) {
      const profileFragment = resolveProfileFragment(site.profile, llm, opts);
      if (profileFragment == null) {
        // Defensive: `LLMSchema.superRefine` already rejects unknown profile
        // references (and unknown mix arms) at config load, so this branch is
        // unreachable for any config that survived schema validation. Throw a
        // clear error in case a hand-crafted (un-parsed) config slips through.
        throw new Error(
          `LLM call site "${callSite}" references undefined profile "${site.profile}"`,
        );
      }
      biasRef.preset = profileFragment.logitBias;
      applyProfileSampling(samplingRef, profileFragment);
      layers.push(profileConfigFragment(profileFragment));
    }
    // Strip the `profile` discriminator (not a `LLMConfigBase` field) and the
    // sampling params before merging. An explicit call-site `temperature` /
    // `topP` is a deliberate per-site choice, so it COALESCES over the winning
    // profile's pair (only overriding the fields it sets) and is marked sticky
    // so a later silent profile can't clear it — routed through `samplingRef` so
    // it never inherits a shadowed profile's value via merge.
    const {
      profile: _profile,
      temperature: siteTemperature,
      topP: siteTopP,
      ...siteFragment
    } = site;
    if (siteTemperature !== undefined) {
      samplingRef.temperature = siteTemperature;
      samplingRef.temperatureFromCallSite = true;
    }
    if (siteTopP !== undefined) {
      samplingRef.topP = siteTopP;
      samplingRef.topPFromCallSite = true;
    }
    layers.push(siteFragment as Mergeable);
  }
}

function profileConfigFragment(profile: ProfileEntry): Mergeable {
  const {
    source: _source,
    label: _label,
    description: _description,
    // `mix` never reaches here in practice (a mix expands to a standard
    // profile before this point), but strip it defensively so it can never
    // leak into the merged `LLMConfigBase`.
    mix: _mix,
    // `logitBias` is profile-identity metadata, not inheritable config: a
    // preset must apply only to the profile that opted in, never bleed from a
    // lower-precedence (e.g. active) profile into one that merely inherited it.
    // `RetryProvider` resolves it from the applied profile, not the merge.
    logitBias: _logitBias,
    // `temperature`/`top_p` are provider-coupled: only the winning profile
    // contributes them (tracked via `samplingRef`, applied post-merge), so a
    // shadowed profile's sampling can never reach a different provider through
    // the deep-merge. Strip here so no profile's sampling enters the merge.
    temperature: _temperature,
    topP: _topP,
    ...config
  } = profile;
  return config as Mergeable;
}

/**
 * Returns true for objects we should recurse into during deep merge. We
 * deliberately exclude arrays so that array-valued fields (e.g.
 * `pricingOverrides` siblings) get full replacement semantics.
 */
function isPlainObject(value: unknown): value is Mergeable {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Deep-merges a sequence of fragments where each rightward source overrides
 * the previous. For nested plain objects, recurse so partial overrides merge
 * leaf-by-leaf rather than wholesale-replacing the nested object.
 *
 * `undefined` values in a source are skipped (treated as "no opinion"); this
 * matches Zod fragment semantics where unset optional fields are absent.
 *
 * Plain-object values are always cloned (via recursion) rather than aliased,
 * so the returned config is an isolated snapshot — mutating any nested object
 * on the result cannot affect `llm.default`, named profiles, or other call
 * sites' resolutions. Arrays and primitives are copied by reference; the
 * resolver does not return arrays, and primitives are immutable.
 */
function deepMerge(...sources: Mergeable[]): Mergeable {
  const out: Mergeable = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      const existing = out[key];
      if (isPlainObject(value)) {
        // Recurse for any plain-object source. Using `existing` as the base
        // when it's also a plain object preserves leaf-by-leaf merge
        // semantics; otherwise we recurse against an empty object so the
        // result is a freshly-allocated clone rather than an alias.
        const base = isPlainObject(existing) ? existing : ({} as Mergeable);
        out[key] = deepMerge(base, value);
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}

/**
 * Cast helper that documents the intent: after merging `llm.default` (which
 * is `LLMConfigBase`) with optional fragments, every required field is still
 * present, so the result satisfies `LLMConfigBase`.
 */
function finalize(merged: Mergeable): z.infer<typeof LLMConfigBase> {
  return merged as unknown as z.infer<typeof LLMConfigBase>;
}
