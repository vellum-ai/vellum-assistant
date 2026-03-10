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
  ipc_v1: new Set<Scope>(["ipc.all"]),
  ui_page_v1: new Set<Scope>(["settings.read"]),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Resolve a scope profile name to its set of granted scopes. */
export function resolveScopeProfile(profile: ScopeProfile): ReadonlySet<Scope> {
  return PROFILE_SCOPES[profile];
}
