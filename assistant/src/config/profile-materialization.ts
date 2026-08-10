import { getDb } from "../persistence/db-connection.js";
import { ROUTING_IDENTITY_PROVIDERS } from "../providers/inference/auth.js";
import { getConnection } from "../providers/inference/connections.js";
import {
  getCatalogProviderForModel,
  isModelInCatalog,
} from "../providers/model-catalog.js";
import {
  getManagedUpstream,
  MANAGED_ROUTABLE_PROVIDERS,
  VELLUM_MANAGED_CONNECTION_NAME,
} from "../providers/vellum-model-routing.js";
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

  // Completion never stamps a `provider_connection`; an inherited binding
  // would only re-introduce the collapsed field on disk. The default's
  // explicit binding is instead inherited IN the provider value, the
  // entries-model representation: the vellum binding becomes the routing
  // identity (only when it can serve the model, or the read-path schema
  // would strip the profile), and a same-vendor binding becomes the entry
  // name, so a completed profile keeps signing with the credential the
  // workspace default names rather than whatever auto-resolution finds
  // first.
  if (
    completed.provider !== undefined &&
    !ROUTING_IDENTITY_PROVIDERS.has(completed.provider) &&
    profile.provider_connection === undefined &&
    dflt.provider_connection !== undefined
  ) {
    if (dflt.provider_connection === VELLUM_MANAGED_CONNECTION_NAME) {
      // Only managed-servable pairs inherit the managed binding; anything
      // else inherits nothing and lets dispatch auto-resolve by vendor,
      // matching the pre-entries inheritance contract.
      if (
        MANAGED_ROUTABLE_PROVIDERS.has(completed.provider) &&
        completed.model !== undefined &&
        getManagedUpstream(completed.model) !== null
      ) {
        completed.provider = "vellum";
      }
    } else if (completed.provider === dflt.provider) {
      // Folding to the entry name is only safe against a verified row; a
      // dangling or kind-disagreeing binding stays in the legacy field,
      // where the collapse migration's recovery can judge it.
      if (bindingRowKind(dflt.provider_connection) === completed.provider) {
        completed.provider = dflt.provider_connection;
      } else {
        completed.provider_connection = dflt.provider_connection;
      }
    }
  }
  return structuredClone(completed);
}

/**
 * The provider kind stored on a connection row, or null when the row is
 * missing or the DB is unavailable (both mean "unverifiable" to callers).
 */
function bindingRowKind(name: string): string | null {
  try {
    return getConnection(getDb(), name)?.provider ?? null;
  } catch {
    return null;
  }
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
