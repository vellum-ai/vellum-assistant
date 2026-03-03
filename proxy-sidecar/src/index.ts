// Core proxy types
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
} from './types.js';

// Host pattern matching
export {
  compareMatchSpecificity,
  matchHostPattern,
} from './host-pattern-match.js';
export type {
  HostMatchKind,
  MatchHostPatternOptions,
} from './host-pattern-match.js';

// Certificate management
export {
  ensureCombinedCABundle,
  ensureLocalCA,
  getCAPath,
  getCombinedCAPath,
  issueLeafCert,
} from './certs.js';

// MITM handler
export { handleMitm } from './mitm-handler.js';
export type { RewriteCallback } from './mitm-handler.js';

// Router
export { routeConnection } from './router.js';
export type { RouteDecision, RouteReason } from './router.js';

// CONNECT tunnel
export { handleConnect } from './connect-tunnel.js';

// Policy engine
export { evaluateRequest, evaluateRequestWithApproval } from './policy.js';

// HTTP forwarder
export { forwardHttpRequest } from './http-forwarder.js';
export type { PolicyCallback } from './http-forwarder.js';

// Proxy server
export { createProxyServer } from './server.js';
export type { MitmHandlerConfig, ProxyServerConfig } from './server.js';

// Sidecar configuration
export { ConfigError, loadConfig } from './config.js';
export type { SidecarConfig } from './config.js';

// Health / readiness server
export { createHealthServer } from './health.js';
export type { HealthServerOptions } from './health.js';

// Logging/diagnostics
export {
  buildCredentialRefTrace,
  buildDecisionTrace,
  createSafeLogEntry,
  sanitizeHeaders,
  sanitizeUrl,
  stripQueryString,
} from './logging.js';
export type { CredentialRefTrace, ProxyDecisionTrace } from './logging.js';
