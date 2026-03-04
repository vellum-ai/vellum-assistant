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

// ---------------------------------------------------------------------------
// Credential modules
// ---------------------------------------------------------------------------

// Credential broker
export {
  CredentialBroker,
  credentialBroker,
} from './credentials/broker.js';
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
} from './credentials/broker.js';

// Credential dependency injection
export {
  configureGetDataDir,
  configureGetLogger,
  configureGetSecureKey,
  configurePostConnectHooks,
} from './credentials/deps.js';
export type { CredentialLogger } from './credentials/deps.js';

// Domain policy
export { isDomainAllowed } from './credentials/domain-policy.js';

// Metadata store
export {
  _setMetadataPath,
  assertMetadataWritable,
  deleteCredentialMetadata,
  getCredentialMetadata,
  getCredentialMetadataById,
  listCredentialMetadata,
  upsertCredentialMetadata,
} from './credentials/metadata-store.js';
export type { CredentialMetadata } from './credentials/metadata-store.js';

// Policy validation
export {
  createStrictDefaultPolicy,
  toPolicyFromInput,
  validatePolicyInput,
} from './credentials/policy-validate.js';
export type { ValidationResult } from './credentials/policy-validate.js';

// Post-connect hooks
export { runPostConnectHook } from './credentials/post-connect-hooks.js';
export type { PostConnectHookContext } from './credentials/post-connect-hooks.js';

// Credential resolver
export {
  resolveById,
  resolveByServiceField,
  resolveCredentialRef,
  resolveForDomain,
} from './credentials/resolve.js';
export type { ResolvedCredential } from './credentials/resolve.js';

// Credential selection
export { rankCredentialsForEndpoint } from './credentials/selection.js';
export type {
  CredentialCandidate,
  CredentialSelectionResult,
} from './credentials/selection.js';

// Tool policy
export { isToolAllowed } from './credentials/tool-policy.js';
