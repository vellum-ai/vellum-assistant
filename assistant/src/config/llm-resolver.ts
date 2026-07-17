import { z } from "zod";

import {
  getCatalogProviderForModel,
  isModelInCatalog,
} from "../providers/model-catalog.js";
import {
  MANAGED_ROUTABLE_PROVIDERS,
  VELLUM_MANAGED_CONNECTION_NAME,
} from "../providers/vellum-model-routing.js";
import { CALL_SITE_DEFAULTS } from "./call-site-defaults.js";
import {
  getEffectiveProfile,
  isDefaultProfileKey,
  resolveDefaultProfileForProvider,
} from "./default-profile-catalog.js";
import {
  type LLMCallSite,
  LLMConfigBase,
  type LLMSchema,
  type ProfileEntry,
} from "./schemas/llm.js";

/**
 * Resolves a fully-specified `LLMConfigBase` for a given call site.
 *
 * Selection is a single-winner chain (see `selectWinningProfile`): the
 * highest-precedence rung that names a usable, complete profile wins, and the
 * resolved config is composed as code-owned schema defaults + the winning
 * profile's fragment + the call site's own tuning tweak. No profile ever
 * contributes a field to another profile — `deepMerge` here only lets nested
 * tweaks (e.g. `thinking.enabled`) combine leaf-wise with the winner rather
 * than wholesale-replacing sibling fields.
 *
 * Precedence of the selection chain (high → low):
 *   1. `opts.overrideProfile` (per-turn / per-conversation pin)
 *   2. `llm.activeProfile` — `mainAgent` only, since it IS that call site's
 *      user-facing chat-model selection
 *   3. `llm.callSites[callSite].profile` (the call site's named profile)
 *   4. `CALL_SITE_DEFAULTS[callSite].profile` intent resolved through
 *      `llm.defaultProvider`
 *   5. balanced intent through `llm.defaultProvider` — the code-owned anchor
 *      for profileless call sites, or when nothing above is usable
 *
 * A winner must carry its own `provider` AND `model`: the base layer's schema
 * default identity never stands in for a selected profile. The anchor is
 * code-owned and resolved through `llm.defaultProvider`, never through
 * user-mutable state.
 *
 * `temperature`/`top_p` come only from the winner (or an explicit call-site
 * tweak); `logitBias` only ever from the winner. These are provider-coupled, so
 * a shadowed profile can never leak its sampling onto a different provider.
 *
 * `opts.forceOverrideProfile` is a no-op here: the override profile already
 * sits at the top of the chain for every call site.
 *
 * Profile names are resolved against the effective profile catalog
 * (code-defined defaults + workspace `llm.profiles`; see `getEffectiveProfile`).
 * A "mix" profile is expanded to one of its arms by a seeded weighted pick (see
 * `resolveProfileFragment` and `opts.selectionSeed`), uniformly wherever a name
 * is dereferenced. Missing references silently fall through (no throw) so the
 * resolver stays pure; schema validation catches unknown static references at
 * config-load time.
 *
 * Nested objects (`thinking`, `contextWindow`, and
 * `contextWindow.overflowRecovery`) are deep-merged so partial tweaks at any
 * nesting level merge into — rather than replace — the corresponding base
 * value.
 *
 * Pure & synchronous: no I/O, no async work. (Random selection only occurs for
 * mix profiles when no `selectionSeed` is supplied; with a seed the pick is
 * deterministic.)
 */
export interface ResolveCallSiteOpts {
  overrideProfile?: string;
  /**
   * Float `overrideProfile` above the call-site layers for non-main-agent call
   * sites. Retained for API compatibility; under single-winner selection the
   * override already sits at the top of the chain, so this is effectively a
   * no-op. Inert when `overrideProfile` is absent or references a missing
   * profile.
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
   * Invoked once per chain rung that named a profile the resolver could not
   * use, before resolution continues to the next rung. Fallback is silent to
   * the call but must be visible in logs — callers on user-facing paths should
   * log at warn.
   */
  onResolutionFallback?: (info: {
    callSite: LLMCallSite;
    requested: string;
    reason: ResolutionFallbackReason;
  }) => void;
}

export type ResolutionFallbackReason = "missing" | "disabled" | "incomplete";

export function resolveCallSiteConfig(
  callSite: LLMCallSite,
  llm: z.infer<typeof LLMSchema>,
  opts: ResolveCallSiteOpts = {},
): z.infer<typeof LLMConfigBase> {
  return resolveOverrideOrDefault(callSite, llm, opts);
}

// ─── Single-winner profile resolution ───────────────────────────────────────
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
// would be merge inheritance by the back door). A fallback anchor must be
// code-owned, never user-mutable state.
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
 * Dereference a profile name for the override-or-default rungs. A
 * default-profile key must yield the same body the call-site intent rung
 * would — the default provider's column, never unconditionally the vellum
 * column.
 *
 * A persisted managed stub carries no user intent (defaults cannot be
 * disabled through any write path), so the pure catalog overrides an
 * unusable one. An unusable user-owned shadow is returned as-is so the rung
 * reports it and falls through.
 */
function providerAwareEntry(
  llm: z.infer<typeof LLMSchema>,
  name: string,
): ProfileEntry | undefined {
  const defaultProvider = llm.defaultProvider ?? null;
  const entry = resolveDefaultProfileForProvider(
    llm.profiles,
    name,
    defaultProvider,
  );
  if (!isDefaultProfileKey(name) || entry?.mix != null) {
    return entry;
  }
  if (
    entry != null &&
    entry.status !== "disabled" &&
    entry.provider != null &&
    entry.model != null
  ) {
    return entry;
  }
  const workspace = llm.profiles?.[name];
  if (workspace != null && workspace.source !== "managed") {
    return entry;
  }
  return resolveDefaultProfileForProvider(undefined, name, defaultProvider);
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
  const named = providerAwareEntry(llm, name);
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
    named.mix == null
      ? named
      : resolveProfileFragment(name, llm, opts, (n) =>
          providerAwareEntry(llm, n),
        );
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
    entry = resolveProfileFragment(intent, llm, opts, (n) =>
      providerAwareEntry(llm, n),
    );
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
 * fall to these code-owned defaults; the winner's identity fields are
 * guaranteed present by `selectWinningProfile`.
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
  // code default wholesale. `profile` is the selection discriminator and
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
  if (!(total > 0)) {
    return entries[0];
  }
  let threshold = unit * total;
  for (const entry of entries) {
    threshold -= entry.weight;
    if (threshold < 0) {
      return entry;
    }
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
  lookupEntry: (name: string) => ProfileEntry | undefined = (n) =>
    getEffectiveProfile(llm.profiles, n),
): ProfileEntry | undefined {
  if (name == null) {
    return undefined;
  }
  const entry = lookupEntry(name);
  if (entry?.mix == null) {
    return entry;
  }

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
  return lookupEntry(chosen.profile);
}

/**
 * Returns the profile key `resolveCallSiteConfig` selects as the winner for a
 * call site when no per-turn `overrideProfile` is supplied — the highest-
 * precedence rung that resolves to a usable, complete profile (see
 * `selectWinningProfile`). Returns `undefined` when the winner is the
 * code-owned anchor rather than a named profile.
 */
export function resolveDefaultProfileKey(
  callSite: LLMCallSite,
  llm: z.infer<typeof LLMSchema>,
): string | undefined {
  return selectWinningProfile(callSite, llm, {}).profileName ?? undefined;
}

/**
 * Returns the profile key that `resolveCallSiteConfig` treats as the winning
 * (highest-precedence) profile for a turn — the profile whose fragment supplies
 * the resolved provider/model. Accounts for the per-turn `overrideProfile`, so
 * error attribution names the slot the resolver really used. Returns
 * `undefined` when the winner is the code-owned anchor rather than a named
 * profile.
 */
export function resolveEffectiveProfileKey(
  callSite: LLMCallSite,
  llm: z.infer<typeof LLMSchema>,
  opts: ResolveCallSiteOpts = {},
): string | undefined {
  return selectWinningProfile(callSite, llm, opts).profileName ?? undefined;
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
    return "default";
  }
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
 * on the result cannot affect named profiles or other call sites' resolutions.
 * Arrays and primitives are copied by reference; the resolver does not return
 * arrays, and primitives are immutable.
 */
function deepMerge(...sources: Mergeable[]): Mergeable {
  const out: Mergeable = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) {
        continue;
      }
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
 * Cast helper that documents the intent: after merging the code-owned base
 * (which is `LLMConfigBase`) with optional fragments, every required field is
 * still present, so the result satisfies `LLMConfigBase`.
 */
function finalize(merged: Mergeable): z.infer<typeof LLMConfigBase> {
  return merged as unknown as z.infer<typeof LLMConfigBase>;
}
