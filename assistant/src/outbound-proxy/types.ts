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

/** Unique identifier for a proxy session. */
export type ProxySessionId = string;

export type ProxySessionStatus = "starting" | "active" | "stopping" | "stopped";

export interface ProxySession {
  id: ProxySessionId;
  conversationId: string;
  credentialIds: string[];
  status: ProxySessionStatus;
  createdAt: Date;
  /** Ephemeral port assigned once the session starts listening. */
  port: number | null;
}

export interface ProxySessionConfig {
  /** How long (ms) an idle session stays alive before auto-stopping. */
  idleTimeoutMs: number;
  /** Maximum concurrent sessions per conversation. */
  maxSessionsPerConversation: number;
}

export interface ProxyEnvVars {
  HTTP_PROXY: string;
  HTTPS_PROXY: string;
  NO_PROXY: string;
  NODE_EXTRA_CA_CERTS?: string;
  /** Combined CA bundle (system roots + proxy CA) for non-Node TLS clients (curl, Python, etc.). */
  SSL_CERT_FILE?: string;
}

// ---------------------------------------------------------------------------
// Policy engine types
// ---------------------------------------------------------------------------

/** A single credential matched -- inject it. */
export interface PolicyDecisionMatched {
  kind: "matched";
  credentialId: string;
  template: CredentialInjectionTemplate;
}

/** Multiple credentials match -- caller must disambiguate. */
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

/** No credential_ids were requested -- pass-through. */
export interface PolicyDecisionUnauthenticated {
  kind: "unauthenticated";
}

// ---------------------------------------------------------------------------
// Approval hook outcomes -- structured data for triggering permission prompts.
// ---------------------------------------------------------------------------

/** Context about the outbound request target, used to build permission prompts. */
export interface RequestTargetContext {
  hostname: string;
  port: number | null;
  path: string;
  /** The protocol scheme of the original request ('http' or 'https'). */
  scheme: "http" | "https";
}

/**
 * The target host matches a known credential template pattern, but the
 * session has no credential bound for it. The UI should prompt the user
 * to bind or create a credential.
 */
export interface PolicyDecisionAskMissingCredential {
  kind: "ask_missing_credential";
  target: RequestTargetContext;
  /** Host patterns from the known registry that matched the target. */
  matchingPatterns: string[];
}

/**
 * The request doesn't match any known credential template and the session
 * has no credentials. The UI should prompt the user to allow or deny the
 * unauthenticated request.
 */
export interface PolicyDecisionAskUnauthenticated {
  kind: "ask_unauthenticated";
  target: RequestTargetContext;
}

export type PolicyDecision =
  | PolicyDecisionMatched
  | PolicyDecisionAmbiguous
  | PolicyDecisionMissing
  | PolicyDecisionUnauthenticated
  | PolicyDecisionAskMissingCredential
  | PolicyDecisionAskUnauthenticated;

// ---------------------------------------------------------------------------
// Proxy approval callback -- wires policy "ask" decisions to the UI prompter.
// ---------------------------------------------------------------------------

/**
 * Payload passed to the approval callback when the policy engine emits an
 * `ask_missing_credential` or `ask_unauthenticated` decision. Contains
 * enough context for the prompter to build a meaningful confirmation dialog.
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
 * Callback signature for proxy approval prompts. The proxy service calls
 * this when an outbound request requires user confirmation. Returns `true`
 * if the user approves, `false` if denied.
 */
export type ProxyApprovalCallback = (
  request: ProxyApprovalRequest,
) => Promise<boolean>;
