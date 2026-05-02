// ---------------------------------------------------------------------------
// Core types — re-exported from @vellumai/egress-proxy shared package
// ---------------------------------------------------------------------------

export type {
  CredentialInjectionTemplate,
  CredentialInjectionType,
  PolicyDecision,
  ProxyApprovalCallback,
  ProxyApprovalRequest,
  ProxyEnvVars,
  ProxySession,
  ProxySessionConfig,
  ProxySessionId,
} from "@vellumai/egress-proxy";

// ---------------------------------------------------------------------------
// Conversation core — re-exported from @vellumai/egress-proxy shared package
// ---------------------------------------------------------------------------

export type { ManagedSession, SessionStartHooks } from "@vellumai/egress-proxy";

// ---------------------------------------------------------------------------
// Host pattern matching
// ---------------------------------------------------------------------------

export type {
  HostMatchKind,
  MatchHostPatternOptions,
} from "./host-pattern-match.js";

// Certificate management
export {
  ensureCombinedCABundle,
  ensureLocalCA,
  getCAPath,
  issueLeafCert,
} from "./certs.js";

// MITM handler
export type { RewriteCallback } from "./mitm-handler.js";

// Router
export { routeConnection } from "./router.js";

// CONNECT tunnel

// Policy engine
export { evaluateRequest, evaluateRequestWithApproval } from "./policy.js";

// HTTP forwarder

// Proxy server
export type { ProxyServerConfig } from "./server.js";
export { createProxyServer } from "./server.js";

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
