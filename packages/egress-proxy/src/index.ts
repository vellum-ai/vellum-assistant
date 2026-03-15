/**
 * @vellumai/egress-proxy — Reusable outbound proxy and request-policy core.
 *
 * This package defines the portable primitives shared by the legacy
 * trusted-session shell proxy flows (assistant/src/outbound-proxy) and the
 * CES secure command egress enforcement layer. It intentionally has zero
 * dependencies on assistant runtime or CES server modules.
 */

// ---------------------------------------------------------------------------
// Session identity
// ---------------------------------------------------------------------------

/** Unique identifier for a proxy session (opaque string, typically a UUID). */
export type ProxySessionId = string;

/** Lifecycle states a proxy session progresses through. */
export type ProxySessionStatus = "starting" | "active" | "stopping" | "stopped";

// ---------------------------------------------------------------------------
// Environment injection
// ---------------------------------------------------------------------------

/**
 * Environment variables injected into a subprocess so its HTTP(S) traffic
 * is routed through an egress proxy session.
 */
export interface ProxyEnvVars {
  HTTP_PROXY: string;
  HTTPS_PROXY: string;
  NO_PROXY: string;
  /** Extra CA certs path for Node.js / Bun TLS (proxy CA cert). */
  NODE_EXTRA_CA_CERTS?: string;
  /** Combined CA bundle (system roots + proxy CA) for non-Node TLS clients. */
  SSL_CERT_FILE?: string;
}

/** How a credential value is injected into an outbound proxied request. */
export type CredentialInjectionType = "header" | "query";

/**
 * Describes where and how to inject a credential into proxied requests
 * matching a specific host pattern.
 */
export interface CredentialInjectionTemplate {
  /** Glob pattern for matching request hosts (e.g. "*.fal.ai"). */
  hostPattern: string;
  /** Where the credential value is injected. */
  injectionType: CredentialInjectionType;
  /** Header name when injectionType is 'header' (e.g. "Authorization"). */
  headerName?: string;
  /** Prefix prepended to the secret value (e.g. "Key ", "Bearer "). */
  valuePrefix?: string;
  /** Query parameter name when injectionType is 'query'. */
  queryParamName?: string;
}

// ---------------------------------------------------------------------------
// Request target context
// ---------------------------------------------------------------------------

/**
 * Context about an outbound request target, used by the policy engine and
 * approval prompts.
 */
export interface RequestTargetContext {
  hostname: string;
  port: number | null;
  path: string;
  /** The protocol scheme of the original request ('http' or 'https'). */
  scheme: "http" | "https";
}

// ---------------------------------------------------------------------------
// Policy decisions
// ---------------------------------------------------------------------------

/** A single credential matched — inject it. */
export interface PolicyDecisionMatched {
  kind: "matched";
  credentialId: string;
  template: CredentialInjectionTemplate;
}

/** Multiple credentials match — caller must disambiguate. */
export interface PolicyDecisionAmbiguous {
  kind: "ambiguous";
  candidates: Array<{
    credentialId: string;
    template: CredentialInjectionTemplate;
  }>;
}

/** No credential matches the target host/path. */
export interface PolicyDecisionMissing {
  kind: "missing";
}

/** No credential_ids were requested — pass-through. */
export interface PolicyDecisionUnauthenticated {
  kind: "unauthenticated";
}

/**
 * The target host matches a known credential template pattern, but the
 * session has no credential bound for it.
 */
export interface PolicyDecisionAskMissingCredential {
  kind: "ask_missing_credential";
  target: RequestTargetContext;
  /** Host patterns from the known registry that matched the target. */
  matchingPatterns: string[];
}

/**
 * The request doesn't match any known credential template and the session
 * has no credentials.
 */
export interface PolicyDecisionAskUnauthenticated {
  kind: "ask_unauthenticated";
  target: RequestTargetContext;
}

/** Union of all possible policy evaluation outcomes. */
export type PolicyDecision =
  | PolicyDecisionMatched
  | PolicyDecisionAmbiguous
  | PolicyDecisionMissing
  | PolicyDecisionUnauthenticated
  | PolicyDecisionAskMissingCredential
  | PolicyDecisionAskUnauthenticated;

// ---------------------------------------------------------------------------
// Policy callback shapes
// ---------------------------------------------------------------------------

/**
 * Callback invoked by the proxy HTTP forwarder for each outbound request.
 * Returns injected headers on allow, or `null` to block the request.
 */
export type PolicyCallback = (
  hostname: string,
  port: number | null,
  path: string,
  scheme: "http" | "https",
) => Promise<Record<string, string> | null>;

/**
 * Payload passed to the approval callback when the policy engine emits an
 * `ask_missing_credential` or `ask_unauthenticated` decision.
 */
export interface ProxyApprovalRequest {
  /** The policy decision that triggered the approval prompt. */
  decision:
    | PolicyDecisionAskMissingCredential
    | PolicyDecisionAskUnauthenticated;
  /** The proxy session ID that originated the request. */
  sessionId: ProxySessionId;
}

/**
 * Callback signature for proxy approval prompts. Returns `true` if the
 * user approves, `false` if denied.
 */
export type ProxyApprovalCallback = (
  request: ProxyApprovalRequest,
) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Session configuration
// ---------------------------------------------------------------------------

/** Tuning knobs for a proxy session. */
export interface ProxySessionConfig {
  /** How long (ms) an idle session stays alive before auto-stopping. */
  idleTimeoutMs: number;
  /** Maximum concurrent sessions per conversation. */
  maxSessionsPerConversation: number;
}
