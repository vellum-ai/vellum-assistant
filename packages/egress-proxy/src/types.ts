/**
 * Core type definitions for @vellumai/egress-proxy.
 *
 * These types define the portable primitives shared by the assistant
 * trusted-session proxy flows and the CES secure command egress
 * enforcement layer. They intentionally have zero dependencies on
 * assistant runtime or CES server modules.
 */

// ---------------------------------------------------------------------------
// Session identity
// ---------------------------------------------------------------------------

/** Unique identifier for a proxy session (opaque string, typically a UUID). */
export type ProxySessionId = string;

/** Lifecycle states a proxy session progresses through. */
export type ProxySessionStatus = "starting" | "active" | "stopping" | "stopped";

// ---------------------------------------------------------------------------
// Session model
// ---------------------------------------------------------------------------

/** Runtime representation of a proxy session. */
export interface ProxySession {
  id: ProxySessionId;
  conversationId: string;
  credentialIds: string[];
  status: ProxySessionStatus;
  createdAt: Date;
  /** Ephemeral port assigned once the session starts listening. */
  port: number | null;
}

// ---------------------------------------------------------------------------
// Allowed network target
// ---------------------------------------------------------------------------

/**
 * Describes a network target that an egress proxy session is allowed to
 * connect to. Carries host, port, and protocol restrictions from the
 * secure command manifest.
 */
export interface AllowedTarget {
  /** Host glob pattern (e.g. "api.github.com", "*.amazonaws.com"). */
  host: string;
  /** Allowed port(s). When omitted or empty, any port is allowed. */
  ports?: number[];
  /** Allowed protocol(s) ("http" | "https"). When omitted or empty, any protocol is allowed. */
  protocols?: Array<"http" | "https">;
}

// ---------------------------------------------------------------------------
// Session configuration
// ---------------------------------------------------------------------------

/** Tuning knobs for a proxy session. */
export interface ProxySessionConfig {
  /** How long (ms) an idle session stays alive before auto-stopping. */
  idleTimeoutMs: number;
  /** Maximum concurrent sessions per conversation. */
  maxSessionsPerConversation: number;
  /**
   * Per-command network target allowlist.
   * When set, the proxy server MUST reject outbound connections to targets
   * that do not match any entry. Used by CES egress enforcement to carry
   * manifest `allowedNetworkTargets` through to the proxy session.
   *
   * Each entry specifies a host glob pattern and optional port/protocol
   * restrictions. When `ports` is omitted, any port is allowed. When
   * `protocols` is omitted, any protocol is allowed.
   */
  allowedTargets?: AllowedTarget[];
}

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

// ---------------------------------------------------------------------------
// Credential injection
// ---------------------------------------------------------------------------

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
 *
 * `method` and `requestHeaders` are populated for plain-HTTP proxied
 * requests (absolute-URL form). For HTTPS CONNECT tunnels the proxy has
 * not yet terminated TLS and cannot see HTTP-level details, so these are
 * left undefined.
 */
export type PolicyCallback = (
  hostname: string,
  port: number | null,
  path: string,
  scheme: "http" | "https",
  method?: string,
  requestHeaders?: Record<string, string | string[] | undefined>,
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
  /**
   * HTTP method of the incoming request, when available. Undefined for HTTPS
   * CONNECT tunnels — at CONNECT time the proxy has not terminated TLS so
   * no HTTP-level information is visible.
   */
  method?: string;
  /**
   * Curated subset of request headers, when available. Only non-sensitive
   * headers are surfaced (content-type, content-length, user-agent, accept).
   * Undefined for HTTPS CONNECT tunnels.
   */
  requestHeaders?: Record<string, string>;
}

/**
 * Callback signature for proxy approval prompts. Returns `true` if the
 * user approves, `false` if denied.
 */
export type ProxyApprovalCallback = (
  request: ProxyApprovalRequest,
) => Promise<boolean>;
