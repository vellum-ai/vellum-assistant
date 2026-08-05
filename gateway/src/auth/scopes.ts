/**
 * Scope profile resolver and scope-check utilities.
 *
 * Each scope profile maps to a fixed set of permission scopes. The
 * mapping is intentionally hard-coded — profile definitions are a
 * policy decision, not a runtime configuration.
 */

import type { Scope, ScopeProfile } from "./types.js";

// ---------------------------------------------------------------------------
// Profile -> scope mapping
// ---------------------------------------------------------------------------

const PROFILE_SCOPES: Record<ScopeProfile, ReadonlySet<Scope>> = {
  actor_client_v1: new Set<Scope>([
    "admin.write",
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
