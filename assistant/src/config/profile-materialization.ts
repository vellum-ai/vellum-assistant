import {
  getCatalogProviderForModel,
  isModelInCatalog,
} from "../providers/model-catalog.js";
import {
  MANAGED_ROUTABLE_PROVIDERS,
  VELLUM_MANAGED_CONNECTION_NAME,
} from "../providers/vellum-model-routing.js";
import type { LLMConfigBase, ProfileEntry } from "./schemas/llm.js";

/**
 * Materializes a partial custom profile into a complete, standalone
 * override: what `resolveCallSiteConfig` produces when this profile is the
 * only profile layer above `llm.default`. Replicates the deep-merge
 * resolver's non-obvious rules exactly:
 *
 * - Non-null default `temperature`/`topP` ARE inherited — winning-profile
 *   scoping only blocks one profile's sampling from leaking under another;
 *   `llm.default`'s base sampling stands when no profile opts in. Null
 *   defaults are skipped (same resolved result, no noise). `logitBias` is
 *   NEVER inherited — the resolver deletes non-profile values post-merge.
 * - A model-only profile gets the provider `withImpliedProviders` would
 *   stamp: the default provider when it serves the model, else the model's
 *   catalog owner.
 *
 * Mix profiles (no config fields, schema-enforced) and managed profiles
 * (bodies owned by the code catalog) pass through untouched. Idempotent,
 * pure, and the result never aliases `dflt`'s nested objects.
 */
export function completeCustomProfile(
  dflt: LLMConfigBase,
  profile: ProfileEntry,
): ProfileEntry {
  if (profile.mix != null || profile.source === "managed") {
    return profile;
  }

  const completed: ProfileEntry = { ...profile };

  if (profile.provider === undefined) {
    completed.provider = dflt.provider;
  }
  if (profile.model === undefined) {
    completed.model = dflt.model;
  }
  if (profile.maxTokens === undefined) {
    completed.maxTokens = dflt.maxTokens;
  }
  if (profile.effort === undefined) {
    completed.effort = dflt.effort;
  }
  if (profile.speed === undefined) {
    completed.speed = dflt.speed;
  }
  if (profile.verbosity === undefined) {
    completed.verbosity = dflt.verbosity;
  }
  if (profile.disableCache === undefined && dflt.disableCache !== undefined) {
    completed.disableCache = dflt.disableCache;
  }
  if (profile.temperature === undefined && dflt.temperature != null) {
    completed.temperature = dflt.temperature;
  }
  if (profile.topP === undefined && dflt.topP != null) {
    completed.topP = dflt.topP;
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

  // A provider-specific connection baked onto a different provider would pin
  // a mismatch (dispatch auto-resolves an absent connection by provider
  // instead). The Vellum managed connection must survive a provider change —
  // dispatch routes it via `expectedProvider` — but only onto providers it
  // can actually route; a non-managed-routable provider (openrouter, ollama)
  // would hit the mismatch path instead of auto-resolution.
  const vellumRoutable =
    dflt.provider_connection === VELLUM_MANAGED_CONNECTION_NAME &&
    completed.provider !== undefined &&
    MANAGED_ROUTABLE_PROVIDERS.has(completed.provider);
  if (
    profile.provider_connection === undefined &&
    dflt.provider_connection !== undefined &&
    (completed.provider === dflt.provider || vellumRoutable)
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
  if (fragment === undefined) {
    return base;
  }
  if (!isPlainObject(base) || !isPlainObject(fragment)) {
    return fragment as T;
  }
  const out: PlainObject = { ...base };
  for (const [key, value] of Object.entries(fragment)) {
    if (value === undefined) {
      continue;
    }
    const existing = out[key];
    out[key] =
      isPlainObject(value) && isPlainObject(existing)
        ? mergeNestedFragment(existing, value)
        : value;
  }
  return out as T;
}
