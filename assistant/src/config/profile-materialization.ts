import { ROUTING_IDENTITY_PROVIDERS } from "../providers/inference/auth.js";
import {
  getCatalogProviderForModel,
  isModelInCatalog,
} from "../providers/model-catalog.js";
import {
  type LLMConfigBase,
  type ProfileEntry,
  routingIdentityModelIssue,
} from "./schemas/llm.js";

/**
 * Materializes a partial custom profile into a complete, standalone
 * override by filling absent fields from `dflt` (the workspace's default
 * base config — the legacy raw `llm.default` blob when one is still on
 * disk, otherwise `LLMConfigBase` schema defaults). Single-winner
 * resolution never merges one profile's fields into another, so a custom
 * profile must carry its own provider and model to be a usable selection
 * target — materialization is what completes it. Rules:
 *
 * - Non-null base `temperature`/`topP` ARE inherited; null values are
 *   skipped (same resolved result, no noise). `logitBias` is NEVER
 *   inherited — it is profile-opt-in only.
 * - A model-only profile gets the provider the catalog implies: the base
 *   provider when it serves the model, else the model's catalog owner.
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

  // A routing-identity fill base serves any model its route can dispatch —
  // identity + model is the complete shape, so no provider implication.
  const fillBaseServesModel = (model: string): boolean =>
    ROUTING_IDENTITY_PROVIDERS.has(dflt.provider)
      ? routingIdentityModelIssue(dflt.provider, model) === null
      : isModelInCatalog(dflt.provider, model);
  if (
    profile.model !== undefined &&
    profile.provider === undefined &&
    !fillBaseServesModel(profile.model)
  ) {
    const implied = getCatalogProviderForModel(profile.model);
    if (implied !== undefined) {
      completed.provider = implied as ProfileEntry["provider"];
    }
  }

  return structuredClone(completed);
}

/**
 * `{...raw, ...completed}` recursively: completed (schema-known) values win,
 * raw keys the schema stripped survive at every depth. Used by boot
 * materialization and the config write path so both preserve unknown keys
 * the same way after `safeParse`.
 */
export function mergePreservingUnknownKeys(
  raw: Record<string, unknown>,
  completed: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw, ...completed };
  for (const [key, value] of Object.entries(completed)) {
    const rawValue = raw[key];
    if (isRecord(value) && isRecord(rawValue)) {
      out[key] = mergePreservingUnknownKeys(rawValue, value);
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
