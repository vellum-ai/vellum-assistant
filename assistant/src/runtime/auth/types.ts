/**
 * Core auth types for the single-header JWT auth system.
 *
 * These types define the token claims, scope profiles, principal types,
 * and the normalized AuthContext that downstream code consumes.
 */

// ---------------------------------------------------------------------------
// Scope profiles — named bundles of permissions
// ---------------------------------------------------------------------------

export type ScopeProfile =
  | "actor_client_v1"
  | "gateway_ingress_v1"
  | "gateway_service_v1"
  | "local_v1"
  | "ui_page_v1";

// ---------------------------------------------------------------------------
// Individual scope strings
// ---------------------------------------------------------------------------

export type Scope =
  | "chat.read"
  | "chat.write"
  | "approval.read"
  | "approval.write"
  | "settings.read"
  | "settings.write"
  | "attachments.read"
  | "attachments.write"
  | "calls.read"
  | "calls.write"
  | "ingress.write"
  | "internal.write"
  | "feature_flags.read"
  | "feature_flags.write"
  | "local.all";

// ---------------------------------------------------------------------------
// Principal types — derived from the sub pattern
// ---------------------------------------------------------------------------

export type PrincipalType = "actor" | "svc_gateway" | "svc_daemon" | "local";

// ---------------------------------------------------------------------------
// Token audience — which service the JWT is intended for
// ---------------------------------------------------------------------------

export type TokenAudience = "vellum-gateway" | "vellum-daemon";

// ---------------------------------------------------------------------------
// JWT claims — the payload inside the token
// ---------------------------------------------------------------------------

export interface TokenClaims {
  iss: "vellum-auth";
  aud: TokenAudience;
  sub: string;
  scope_profile: ScopeProfile;
  exp: number;
  policy_epoch: number;
  iat?: number;
  jti?: string;
}

// ---------------------------------------------------------------------------
// AuthContext — normalized auth state for downstream consumers
// ---------------------------------------------------------------------------

export interface AuthContext {
  subject: string;
  principalType: PrincipalType;
  assistantId: string;
  actorPrincipalId?: string;
  conversationId?: string;
  scopeProfile: ScopeProfile;
  scopes: ReadonlySet<Scope>;
  policyEpoch: number;
}
