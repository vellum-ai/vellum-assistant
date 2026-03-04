/**
 * Auth module barrel export.
 *
 * Re-exports all public types and functions from the auth subsystem
 * so consumers can import from a single path.
 */

export type { BuildAuthContextResult } from "./context.js";
export { buildAuthContext } from "./context.js";
export type {
  CredentialPairResult,
  RefreshErrorCode,
  RotateResult,
} from "./credential-service.js";
export { mintCredentialPair, rotateCredentials } from "./credential-service.js";
export {
  getExternalAssistantId,
  resetExternalAssistantIdCache,
} from "./external-assistant-id.js";
export type { AuthenticateResult } from "./middleware.js";
export { authenticateRequest } from "./middleware.js";
export { CURRENT_POLICY_EPOCH, isStaleEpoch } from "./policy.js";
export type { RoutePolicy } from "./route-policy.js";
export { enforcePolicy, getPolicy, registerPolicy } from "./route-policy.js";
export { hasAllScopes, hasScope, resolveScopeProfile } from "./scopes.js";
export type { ParseSubResult } from "./subject.js";
export { parseSub } from "./subject.js";
export type { VerifyResult } from "./token-service.js";
export {
  hashToken,
  initAuthSigningKey,
  loadOrCreateSigningKey,
  mintDaemonDeliveryToken,
  mintToken,
  verifyToken,
} from "./token-service.js";
export type {
  AuthContext,
  PrincipalType,
  Scope,
  ScopeProfile,
  TokenAudience,
  TokenClaims,
} from "./types.js";
