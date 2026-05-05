// ---------------------------------------------------------------------------
// Core types — re-exported from @vellumai/egress-proxy shared package
// ---------------------------------------------------------------------------

export type {
  PolicyDecision,
  ProxyApprovalCallback,
  ProxyApprovalRequest,
} from "@vellumai/egress-proxy";

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
