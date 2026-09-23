/**
 * Scope profile resolver and scope-check utilities.
 *
 * Each scope profile maps to a fixed set of permission scopes. The
 * mapping is intentionally hard-coded — profile definitions are a
 * policy decision, not a runtime configuration.
 */

import type { AuthContext, Scope, ScopeProfile } from "./types.js";

// ---------------------------------------------------------------------------
// Profile -> scope mapping
// ---------------------------------------------------------------------------

const PROFILE_SCOPES: Record<ScopeProfile, ReadonlySet<Scope>> = {
  actor_client_v1: new Set<Scope>([
    "chat.read",
    "chat.write",
    "approval.read",
    "approval.write",
    "settings.read",
    "settings.write",
    "attachments.read",
    "attachments.write",
    "calls.read",
    "calls.write",
    "feature_flags.read",
    "feature_flags.write",
  ]),
  // A non-guardian principal. Excludes the settings, feature-flag and call
  // scopes `actor_client_v1` carries: those reach the control plane, which
  // only the guardian may write.
  // Carries no read scope. The routes behind `chat.read`, `approval.read` and
  // `attachments.read` take a caller-supplied conversation or attachment id
  // and never check who is asking, so they return the guardian's data to any
  // holder. Each read is added back once its routes filter by caller.
  contact_client_v1: new Set<Scope>([
    "chat.write",
    "approval.write",
    "attachments.write",
  ]),
  gateway_ingress_v1: new Set<Scope>(["ingress.write", "internal.write"]),
  gateway_service_v1: new Set<Scope>([
    "chat.read",
    "chat.write",
    "settings.read",
    "settings.write",
    "attachments.read",
    "attachments.write",
    "internal.write",
  ]),
  local_v1: new Set<Scope>(["local.all"]),
  // A grant minted for a third-party CLI to reach the OAuth passthrough
  // route. `enforcePolicy` admits it only where the route's policy names
  // oauth.proxy, so a route naming no scope refuses it too.
  oauth_proxy_v1: new Set<Scope>(["oauth.proxy"]),
  // Managed speech relay only (ATL-1033): the daemon's relay-dial token must
  // not open any other edge-scoped route.
  speech_relay_v1: new Set<Scope>(["speech.relay"]),
  ui_page_v1: new Set<Scope>(["settings.read"]),
};

const EMPTY_SCOPES: ReadonlySet<Scope> = new Set();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Resolve a scope profile name to its set of granted scopes. */
export function resolveScopeProfile(profile: ScopeProfile): ReadonlySet<Scope> {
  // Claims come from JSON, so an unrecognized profile (e.g. minted by a newer
  // peer) can reach this despite the type. Resolve it to no scopes, not a
  // TypeError in the caller. The own-property check keeps inherited keys
  // ("toString", "constructor") failing closed too.
  if (!Object.prototype.hasOwnProperty.call(PROFILE_SCOPES, profile)) {
    return EMPTY_SCOPES;
  }
  return PROFILE_SCOPES[profile];
}

/** Check whether the auth context includes a specific scope. */
export function hasScope(ctx: AuthContext, scope: Scope): boolean {
  return ctx.scopes.has(scope);
}

/** Check whether the auth context includes all of the given scopes. */
export function hasAllScopes(ctx: AuthContext, ...scopes: Scope[]): boolean {
  return scopes.every((s) => ctx.scopes.has(s));
}

// ---------------------------------------------------------------------------
// Profile breadth
// ---------------------------------------------------------------------------

/**
 * Whether a profile is broad enough to stand for its caller on a route that
 * names no scope of its own. A profile marked `false` is minted for a single
 * route and handed to code outside this install's trust boundary, so it
 * reaches only a route whose policy names the scope it carries.
 *
 * Exhaustive over `ScopeProfile`, so a new profile has to be classified here
 * rather than inheriting whichever answer the compiler allows.
 */
const BROAD_SCOPE_PROFILES: Record<ScopeProfile, boolean> = {
  actor_client_v1: true,
  // Narrow: a route naming no scope is a route no one has judged a contact
  // against, so it refuses them rather than admitting any valid token.
  contact_client_v1: false,
  gateway_ingress_v1: true,
  gateway_service_v1: true,
  local_v1: true,
  oauth_proxy_v1: false,
  speech_relay_v1: false,
  ui_page_v1: true,
};

/**
 * True when the profile reaches only a route whose policy names the scope it
 * carries.
 *
 * Claims come from JSON, so an unrecognized profile reaches this despite the
 * type. `=== true` keeps those narrow, along with inherited keys
 * ("constructor", "__proto__") whose values are objects.
 */
export function isNarrowScopeProfile(profile: ScopeProfile): boolean {
  return BROAD_SCOPE_PROFILES[profile] !== true;
}
