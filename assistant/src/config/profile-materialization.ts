import {
  getCatalogProviderForModel,
  isModelInCatalog,
} from "../providers/model-catalog.js";
import type { LLMConfigBase, ProfileEntry } from "./schemas/llm.js";

/**
 * Materializes a partial custom profile into a complete, standalone override
 * by baking in the fields it currently inherits from `llm.default` under the
 * deep-merge resolver.
 *
 * The completed entry pins the profile's *standalone* meaning: what
 * `resolveCallSiteConfig` produces today when this profile is the only
 * profile layer above `llm.default` (e.g. an override on a profile-less call
 * site). This is the baseline the M6 override-or-default resolver assumes —
 * once resolution stops merging, a profile must carry everything it means.
 *
 * Deliberate parity quirks with the current resolver:
 *
 * - `temperature`, `topP`, and `logitBias` are NEVER inherited. They are
 *   winning-profile-scoped in `resolveCallSiteConfig` (a profile that omits
 *   them resolves without them regardless of `llm.default`), so baking them
 *   in would change behavior.
 * - Nested `thinking`/`contextWindow`/`openrouter` fragments merge
 *   leaf-by-leaf into the default's full object, mirroring the resolver's
 *   `deepMerge`.
 * - A model-only profile gets the provider `withImpliedProviders` would
 *   stamp: the inherited default provider when it serves the model, else the
 *   model's catalog owner.
 * - The default's `provider_connection` is inherited only when the completed
 *   provider is still the default's provider; a profile that resolves to a
 *   different provider (explicitly or via model implication) gets no baked
 *   connection, and dispatch auto-resolves by provider as it does today.
 *
 * Mix profiles (no config fields, schema-enforced) and managed profiles
 * (bodies owned by the code catalog) pass through untouched.
 *
 * Idempotent: completing an already-complete profile is the identity.
 * Pure and synchronous; the returned entry never aliases `dflt`'s nested
 * objects.
 */
export function completeCustomProfile(
  dflt: LLMConfigBase,
  profile: ProfileEntry,
): ProfileEntry {
  if (profile.mix != null || profile.source === "managed") return profile;

  const completed: ProfileEntry = { ...profile };

  if (profile.provider === undefined) completed.provider = dflt.provider;
  if (profile.model === undefined) completed.model = dflt.model;
  if (profile.maxTokens === undefined) completed.maxTokens = dflt.maxTokens;
  if (profile.effort === undefined) completed.effort = dflt.effort;
  if (profile.speed === undefined) completed.speed = dflt.speed;
  if (profile.verbosity === undefined) completed.verbosity = dflt.verbosity;
  if (profile.disableCache === undefined && dflt.disableCache !== undefined) {
    completed.disableCache = dflt.disableCache;
  }

  completed.thinking = mergeNestedFragment(dflt.thinking, profile.thinking);
  completed.contextWindow = mergeNestedFragment(
    dflt.contextWindow,
    profile.contextWindow,
  );
  completed.openrouter = mergeNestedFragment(
    dflt.openrouter,
    profile.openrouter,
  );

  if (
    profile.model !== undefined &&
    profile.provider === undefined &&
    !isModelInCatalog(dflt.provider, profile.model)
  ) {
    const implied = getCatalogProviderForModel(profile.model);
    if (implied !== undefined) {
      completed.provider = implied as ProfileEntry["provider"];
    }
  }

  // The default's connection is inherited only when the completed provider
  // is still the default's provider — a connection row belongs to one
  // provider, and stamping it onto a profile that resolved to a different
  // provider (explicitly or via model implication) would bake in a mismatch.
  // Dispatch auto-resolves an absent connection by provider, exactly as it
  // does for the partial profile today.
  if (
    profile.provider_connection === undefined &&
    dflt.provider_connection !== undefined &&
    completed.provider === dflt.provider
  ) {
    completed.provider_connection = dflt.provider_connection;
  }

  return structuredClone(completed);
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Merge a partial nested fragment into the default's full object with the
 * same semantics as the resolver's `deepMerge`: `undefined` fragment values
 * are "no opinion", plain objects recurse, everything else replaces.
 *
 * Intentionally re-declared rather than shared with `llm-resolver.ts`:
 * materialization is a semantic snapshot of the merge behavior profiles were
 * created under, and its output must not drift when the resolver's own merge
 * evolves. (Mirrors the resolver's self-contained `seededUnitFloat`
 * rationale.)
 */
function mergeNestedFragment<T>(base: T, fragment: unknown): T {
  if (fragment === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(fragment)) return fragment as T;
  const out: PlainObject = { ...base };
  for (const [key, value] of Object.entries(fragment)) {
    if (value === undefined) continue;
    const existing = out[key];
    out[key] =
      isPlainObject(value) && isPlainObject(existing)
        ? mergeNestedFragment(existing, value)
        : value;
  }
  return out as T;
}
