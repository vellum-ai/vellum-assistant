import { z } from "zod";

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
 * Merge layers (low → high precedence; later layers override earlier):
 *   1. `llm.default` fields (required base)
 *   2. `llm.profiles[llm.activeProfile]` (workspace-wide active profile)
 *   3. `llm.profiles[opts.overrideProfile]` (per-call ad-hoc override)
 *   4. `llm.profiles[site.profile]` fields (call-site's named profile)
 *   5. `llm.callSites[callSite]` fields (call-site override)
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
 * Pure & synchronous: no I/O, no async work.
 */
export function resolveCallSiteConfig(
  callSite: LLMCallSite,
  llm: z.infer<typeof LLMSchema>,
  opts: { overrideProfile?: string } = {},
): z.infer<typeof LLMConfigBase> {
  const layers: Mergeable[] = [llm.default as Mergeable];

  // Layer: workspace-wide active profile. Silent fall-through on missing key
  // — schema validation in LLMSchema.superRefine catches static references.
  const activeFragment =
    llm.activeProfile != null ? llm.profiles?.[llm.activeProfile] : undefined;
  if (activeFragment != null) {
    layers.push(profileConfigFragment(activeFragment));
  }

  // Layer: per-call ad-hoc override (e.g. a chat conversation's pinned
  // profile). Silent fall-through on missing key keeps the resolver pure.
  const overrideFragment =
    opts.overrideProfile != null
      ? llm.profiles?.[opts.overrideProfile]
      : undefined;
  if (overrideFragment != null) {
    layers.push(profileConfigFragment(overrideFragment));
  }

  const site = llm.callSites?.[callSite];
  if (site != null) {
    if (site.profile != null) {
      const profileFragment: ProfileEntry | undefined =
        llm.profiles?.[site.profile];
      if (profileFragment == null) {
        // Defensive: `LLMSchema.superRefine` already rejects unknown profile
        // references at config load, so this branch is unreachable for any
        // config that survived schema validation. Throw a clear error in case
        // a hand-crafted (un-parsed) config slips through.
        throw new Error(
          `LLM call site "${callSite}" references undefined profile "${site.profile}"`,
        );
      }
      layers.push(profileConfigFragment(profileFragment));
    }
    // Strip the `profile` discriminator before merging — it isn't a
    // `LLMConfigBase` field.
    const { profile: _profile, ...siteFragment } = site;
    layers.push(siteFragment as Mergeable);
  }

  return finalize(deepMerge(...layers));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type Mergeable = Record<string, unknown>;

function profileConfigFragment(profile: ProfileEntry): Mergeable {
  const {
    source: _source,
    label: _label,
    description: _description,
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
