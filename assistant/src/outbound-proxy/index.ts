// ---------------------------------------------------------------------------
// Core types — re-exported from @vellumai/egress-proxy shared package
// ---------------------------------------------------------------------------

export type {
  CredentialInjectionTemplate,
  CredentialInjectionType,
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
} from "@vellumai/egress-proxy";

// ---------------------------------------------------------------------------
// Session core — re-exported from @vellumai/egress-proxy shared package
// ---------------------------------------------------------------------------

export type { ManagedSession, SessionStartHooks } from "@vellumai/egress-proxy";
export {
  cloneSession,
  createSession,
  credentialIdsMatch,
  getActiveSession,
  getOrStartSession,
  getSessionEnv,
  getSessionsForConversation,
  SessionStore,
  startSession,
  stopAllSessions,
  stopSession,
} from "@vellumai/egress-proxy";

// ---------------------------------------------------------------------------
// Host pattern matching
// ---------------------------------------------------------------------------

export type {
  HostMatchKind,
  MatchHostPatternOptions,
} from "./host-pattern-match.js";
export {
  compareMatchSpecificity,
  matchHostPattern,
} from "./host-pattern-match.js";

// Certificate management
export {
  ensureCombinedCABundle,
  ensureLocalCA,
  getCAPath,
  getCombinedCAPath,
  issueLeafCert,
} from "./certs.js";

// MITM handler
export type { RewriteCallback } from "./mitm-handler.js";
export { handleMitm } from "./mitm-handler.js";

// Router
export type { RouteDecision, RouteReason } from "./router.js";
export { routeConnection } from "./router.js";

// CONNECT tunnel
export { handleConnect } from "./connect-tunnel.js";

// Policy engine
export { evaluateRequest, evaluateRequestWithApproval } from "./policy.js";

// HTTP forwarder
export { forwardHttpRequest } from "./http-forwarder.js";

// Proxy server
export type { MitmHandlerConfig, ProxyServerConfig } from "./server.js";
export { createProxyServer } from "./server.js";

// Sidecar configuration
export type { SidecarConfig } from "./config.js";
export { ConfigError, loadConfig } from "./config.js";

// Health / readiness server
export type { HealthServerOptions } from "./health.js";
export { createHealthServer } from "./health.js";

// Logging/diagnostics
export type { CredentialRefTrace, ProxyDecisionTrace } from "./logging.js";
export {
  buildCredentialRefTrace,
  buildDecisionTrace,
  createSafeLogEntry,
  sanitizeHeaders,
  sanitizeUrl,
  stripQueryString,
} from "./logging.js";
