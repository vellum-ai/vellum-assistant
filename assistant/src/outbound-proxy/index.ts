// Core proxy types
export type {
  CredentialCreationFlow,
  CredentialInjectionTemplate,
  CredentialInjectionType,
  CredentialPolicy,
  CredentialPolicyInput,
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

// Host pattern matching
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
export type { PolicyCallback } from "./http-forwarder.js";
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

// ---------------------------------------------------------------------------
// Credential modules
// ---------------------------------------------------------------------------

// Credential broker
export type {
  AuthorizeDenied,
  AuthorizeRequest,
  AuthorizeResult,
  AuthorizeSuccess,
  BrowserFillRequest,
  BrowserFillResult,
  ConsumeResult,
  ServerUseByIdDenied,
  ServerUseByIdRequest,
  ServerUseByIdResult,
  ServerUseByIdSuccess,
  ServerUseRequest,
  ServerUseResult,
  UsageToken,
} from "./credentials/broker.js";
export { CredentialBroker, credentialBroker } from "./credentials/broker.js";

// Credential dependency injection
export type { CredentialLogger } from "./credentials/deps.js";
export {
  configureGetDataDir,
  configureGetLogger,
  configureGetSecureKey,
  configurePostConnectHooks,
} from "./credentials/deps.js";

// Domain policy
export { isDomainAllowed } from "./credentials/domain-policy.js";

// Metadata store
export type { CredentialMetadata } from "./credentials/metadata-store.js";
export {
  _setMetadataPath,
  assertMetadataWritable,
  deleteCredentialMetadata,
  getCredentialMetadata,
  getCredentialMetadataById,
  listCredentialMetadata,
  upsertCredentialMetadata,
} from "./credentials/metadata-store.js";

// Policy validation
export type { ValidationResult } from "./credentials/policy-validate.js";
export {
  createStrictDefaultPolicy,
  toPolicyFromInput,
  validatePolicyInput,
} from "./credentials/policy-validate.js";

// Post-connect hooks
export type { PostConnectHookContext } from "./credentials/post-connect-hooks.js";
export { runPostConnectHook } from "./credentials/post-connect-hooks.js";

// Credential resolver
export type { ResolvedCredential } from "./credentials/resolve.js";
export {
  resolveById,
  resolveByServiceField,
  resolveCredentialRef,
  resolveForDomain,
} from "./credentials/resolve.js";

// Credential selection
export type {
  CredentialCandidate,
  CredentialSelectionResult,
} from "./credentials/selection.js";
export { rankCredentialsForEndpoint } from "./credentials/selection.js";

// Tool policy
export { isToolAllowed } from "./credentials/tool-policy.js";
