import { z } from "zod";

import { getCatalogProviderForModel } from "../providers/model-catalog.js";
import { CALL_SITE_DEFAULTS } from "./call-site-defaults.js";
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
 *   2. `llm.profiles[llm.activeProfile]` (workspace-wide active profile)
 *   3. `llm.profiles[opts.overrideProfile]` (per-call ad-hoc override)
 *   4. `llm.profiles[site.profile]` fields (call-site's named profile)
 *   5. `CALL_SITE_DEFAULTS[callSite]` shipped tuning (see below)
 *   6. `llm.callSites[callSite]` fields (call-site override)
 *
 * For `mainAgent`, the selected active/conversation profile is the direct
 * user intent for the chat loop, so profile layers intentionally sit above
 * any static `llm.callSites.mainAgent` defaults seeded by migrations or UI
 * settings:
 *   1. `llm.default`
 *   2. `llm.profiles[site.profile]`
 *   3. `CALL_SITE_DEFAULTS.mainAgent` shipped tuning (none — see below)
 *   4. `llm.callSites.mainAgent`
 *   5. `llm.profiles[llm.activeProfile]`
 *   6. `llm.profiles[opts.overrideProfile]`
 *
 * Shipped tuning base layer (layer 5 above): `CALL_SITE_DEFAULTS[callSite]`
 * carries the shipped per-site config (e.g. `replySuggestion`'s 60-token cap).
 * When `llm.callSites[callSite]` is ABSENT, that default supplies the whole
 * call-site fragment via `effectiveDefault` (which owns the profile-stripping /
 * `custom-*` fallback rules — unchanged). When `llm.callSites[callSite]` is
 * PRESENT, the shipped default's **tuning fields only** (everything except
 * `profile`) are deep-merged UNDERNEATH the persisted fragment so a partial
 * persisted entry (a migration-seeded `{ model, effort, thinking }` with no
 * `maxTokens`, or a UI-created `{ model }` override) inherits shipped tuning it
 * doesn't itself set instead of shadowing it. The persisted fragment wins
 * per-field; the shipped default's `profile` is never pulled in on this path,
 * so profile selection stays governed by the persisted entry's own `profile`
 * (absent for every migration-seeded entry). `mainAgent`'s shipped entry is
 * `{ profile: "balanced" }` (no tuning), so this base contributes nothing for
 * `mainAgent` and its precedence ordering is unchanged. See
 * `mergeShippedTuningUnderPersisted`.
 *
 * Nested objects (`thinking`, `contextWindow`, and
 * `contextWindow.overflowRecovery`) are deep-merged so partial overrides at
 * any nesting level merge into — rather than replace — the corresponding
 * base value.
 *
 * `activeProfile` and `overrideProfile` are resolved by name lookup against
 * `llm.profiles`. Missing references silently fall through (no throw) so the
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
}

export function resolveCallSiteConfig(
  callSite: LLMCallSite,
  llm: z.infer<typeof LLMSchema>,
  opts: ResolveCallSiteOpts = {},
): z.infer<typeof LLMConfigBase> {
  const layers: Mergeable[] = [llm.default as Mergeable];

  // Effective logit-bias preset, tracked outside the deep-merge so it ties to
  // the single highest-precedence *profile* that wins resolution rather than
  // inheriting from a lower one. Profile layers are appended low→high, and each
  // one fully determines the preset (a profile that omits `logitBias` clears
  // any value a lower-precedence profile set), so the last profile appended
  // wins — matching the merge's own precedence and including the implicit
  // call-site default selected by `effectiveDefault`.
  const biasRef: LogitBiasRef = { preset: undefined };

  const activeFragment = resolveProfileFragment(llm.activeProfile, llm, opts);
  const overrideFragment = resolveProfileFragment(
    opts.overrideProfile,
    llm,
    opts,
  );
  const persisted = llm.callSites?.[callSite];
  const site =
    persisted != null
      ? mergeShippedTuningUnderPersisted(callSite, persisted)
      : effectiveDefault(callSite, llm, opts.overrideProfile != null);

  if (callSite === "mainAgent") {
    appendCallSiteLayers(layers, callSite, llm, site, opts, biasRef);
    appendProfileLayer(layers, activeFragment, biasRef);
    appendProfileLayer(layers, overrideFragment, biasRef);
  } else {
    appendProfileLayer(layers, activeFragment, biasRef);
    appendProfileLayer(layers, overrideFragment, biasRef);
    appendCallSiteLayers(layers, callSite, llm, site, opts, biasRef);
  }

  const resolved = finalize(
    deepMerge(...layers.map(withImpliedProviderForKnownModel)),
  );
  // `logitBias` is profile-scoped: the winning profile is its only source.
  // Overwrite — or clear — whatever the deep-merge may have copied from a
  // non-profile layer (`llm.default` or a call-site fragment), so a preset set
  // outside a profile can't apply to a profile that didn't opt in.
  if (biasRef.preset !== undefined) {
    resolved.logitBias = biasRef.preset;
  } else {
    delete (resolved as { logitBias?: unknown }).logitBias;
  }
  return resolved;
}

type LogitBiasRef = { preset: ProfileEntry["logitBias"] };

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
  const entry = llm.profiles?.[name];
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
  return llm.profiles?.[chosen.profile];
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
  if (callSite === "mainAgent" && llm.activeProfile != null) {
    const active = llm.profiles?.[llm.activeProfile];
    if (active != null && active.status !== "disabled") {
      return llm.activeProfile;
    }
  }

  const dflt = CALL_SITE_DEFAULTS[callSite];
  if (dflt?.profile == null) return undefined;
  const target = llm.profiles?.[dflt.profile];
  if (target != null && target.status !== "disabled") return dflt.profile;
  const customKey = `custom-${dflt.profile}`;
  const customTarget = llm.profiles?.[customKey];
  if (customTarget != null && customTarget.status !== "disabled")
    return customKey;
  return undefined;
}

function effectiveDefault(
  callSite: LLMCallSite,
  llm: z.infer<typeof LLMSchema>,
  hasOverrideProfile = false,
): z.infer<typeof LLMSchema>["callSites"][LLMCallSite] | undefined {
  const dflt = CALL_SITE_DEFAULTS[callSite];
  if (dflt == null) return undefined;
  const targetProfile =
    dflt.profile != null ? llm.profiles?.[dflt.profile] : undefined;
  const profileUnavailable =
    dflt.profile != null &&
    (targetProfile == null || targetProfile.status === "disabled");

  if (profileUnavailable && !hasOverrideProfile) {
    const customKey = `custom-${dflt.profile}`;
    const customProfile = llm.profiles?.[customKey];
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
 * Layer the shipped `CALL_SITE_DEFAULTS` tuning for a call site UNDERNEATH the
 * user's persisted `llm.callSites[id]` fragment, so a partial persisted entry
 * (e.g. a migration-seeded `{ model, effort, thinking }` with no `maxTokens`,
 * or a UI-created `{ model }` override) inherits the shipped tuning it doesn't
 * itself specify instead of shadowing it wholesale. The persisted fragment
 * wins per-field.
 *
 * Only the shipped default's **config tuning** fields participate — its
 * `profile` reference is deliberately stripped. Profile selection for a call
 * site that has a persisted entry stays governed by that entry's own `profile`
 * (which may be absent, as every migration-seeded entry is). Pulling in the
 * shipped default's profile here would silently start applying a named profile
 * to installs whose persisted fragment never had one, changing resolution
 * beyond the tuning restoration this is meant to do. The shipped default's
 * profile is consulted only via `effectiveDefault` on the no-persisted-entry
 * path, where the documented profile-stripping / `custom-*` fallback rules
 * already live and remain unchanged.
 *
 * Nested `thinking` / `contextWindow` are deep-merged so a persisted leaf
 * (e.g. `thinking: { enabled: false }`) merges into — rather than replaces —
 * the shipped nested object. `mainAgent` is unaffected by per-field tuning
 * merge: its `CALL_SITE_DEFAULTS` entry is `{ profile: "balanced" }` (no
 * tuning fields), so the shipped base contributes nothing and the persisted
 * entry passes through verbatim — preserving the documented mainAgent
 * precedence ordering.
 */
function mergeShippedTuningUnderPersisted(
  callSite: LLMCallSite,
  persisted: z.infer<typeof LLMSchema>["callSites"][LLMCallSite] & object,
): z.infer<typeof LLMSchema>["callSites"][LLMCallSite] {
  const dflt = CALL_SITE_DEFAULTS[callSite];
  if (dflt == null) return persisted;
  const { profile: _profile, ...shippedTuning } = dflt;
  if (Object.keys(shippedTuning).length === 0) return persisted;
  // Deep-merge so nested `thinking`/`contextWindow` leaves combine rather than
  // wholesale-replace; the persisted fragment is the rightmost source so its
  // fields win. The result is a fresh object — `deepMerge` clones — so neither
  // `CALL_SITE_DEFAULTS` nor the persisted config is mutated.
  return deepMerge(
    shippedTuning as Mergeable,
    persisted as Mergeable,
  ) as z.infer<typeof LLMSchema>["callSites"][LLMCallSite];
}

function withImpliedProviderForKnownModel(source: Mergeable): Mergeable {
  if (source.provider !== undefined) return source;
  const model = source.model;
  if (typeof model !== "string" || model.length === 0) return source;

  const provider = getCatalogProviderForModel(model);
  if (provider === undefined) return source;

  return {
    ...source,
    provider,
  };
}

function appendProfileLayer(
  layers: Mergeable[],
  profile: ProfileEntry | undefined,
  biasRef: LogitBiasRef,
): void {
  if (profile != null) {
    biasRef.preset = profile.logitBias;
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
      layers.push(profileConfigFragment(profileFragment));
    }
    // Strip the `profile` discriminator before merging — it isn't a
    // `LLMConfigBase` field.
    const { profile: _profile, ...siteFragment } = site;
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
