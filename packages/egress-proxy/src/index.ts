/**
 * @vellumai/egress-proxy — Reusable outbound proxy and request-policy core.
 *
 * This package defines the portable primitives shared by the legacy
 * trusted-session shell proxy flows (assistant/src/outbound-proxy) and the
 * CES secure command egress enforcement layer. It intentionally has zero
 * dependencies on assistant runtime or CES server modules.
 */

// ---------------------------------------------------------------------------
// Types — session, policy, credential injection, env vars
// ---------------------------------------------------------------------------

export type {
  CredentialInjectionTemplate,
  CredentialInjectionType,
  PolicyCallback,
  PolicyDecision,
  PolicyDecisionAmbiguous,
  PolicyDecisionAskMissingCredential,
  PolicyDecisionAskUnauthenticated,
  PolicyDecisionMatched,
  PolicyDecisionMissing,
  PolicyDecisionUnauthenticated,
  ProxyApprovalCallback,
  ProxyApprovalRequest,
  ProxyEnvVars,
  ProxySession,
  ProxySessionConfig,
  ProxySessionId,
  ProxySessionStatus,
  RequestTargetContext,
} from "./types.js";

// ---------------------------------------------------------------------------
// Session core — lifecycle, store, env injection, atomic acquire
// ---------------------------------------------------------------------------

export type { ManagedSession, SessionStartHooks } from "./session-core.js";

export {
  SessionStore,
  cloneSession,
  createSession,
  credentialIdsMatch,
  getActiveSession,
  getOrStartSession,
  getSessionEnv,
  getSessionsForConversation,
  startSession,
  stopAllSessions,
  stopSession,
} from "./session-core.js";
