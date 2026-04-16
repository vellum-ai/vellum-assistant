import { z } from "zod";

import {
  type LLMCallSite,
  LLMConfigBase,
  type LLMConfigFragment,
  type LLMSchema,
} from "./schemas/llm.js";

/**
 * Resolves a fully-specified `LLMConfigBase` for a given call site by layering
 * the call-site override on top of an optional named profile on top of the
 * required `llm.default`.
 *
 * Resolution order (highest precedence wins):
 *   1. `llm.callSites[callSite]` fields (call-site override)
 *   2. `llm.profiles[site.profile]` fields (named profile)
 *   3. `llm.default` fields (required base)
 *
 * Nested objects (`thinking`, `contextWindow`, and
 * `contextWindow.overflowRecovery`) are deep-merged so partial overrides at
 * any nesting level merge into — rather than replace — the corresponding
 * base value.
 *
 * Pure & synchronous: no I/O, no async work.
 */
export function resolveCallSiteConfig(
  callSite: LLMCallSite,
  llm: z.infer<typeof LLMSchema>,
): z.infer<typeof LLMConfigBase> {
  const site = llm.callSites?.[callSite];

  // No site-level entry: deep-merge `default` against an empty fragment so
  // every code path goes through the same merge codepath.
  if (site == null) {
    return finalize(deepMerge(llm.default as Mergeable, {} as Mergeable));
  }

  let profileFragment: LLMConfigFragment | undefined;
  if (site.profile != null) {
    profileFragment = llm.profiles?.[site.profile];
    if (profileFragment == null) {
      // Defensive: `LLMSchema.superRefine` already rejects unknown profile
      // references at config load, so this branch is unreachable for any
      // config that survived schema validation. Throw a clear error in case
      // a hand-crafted (un-parsed) config slips through.
      throw new Error(
        `LLM call site "${callSite}" references undefined profile "${site.profile}"`,
      );
    }
  }

  // Strip the `profile` discriminator before merging — it isn't a
  // `LLMConfigBase` field.
  const { profile: _profile, ...siteFragment } = site;

  const merged = deepMerge(
    llm.default as Mergeable,
    (profileFragment ?? {}) as Mergeable,
    siteFragment as Mergeable,
  );

  return finalize(merged);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type Mergeable = Record<string, unknown>;

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
