/** Unique identifier for a proxy session. */
export type ProxySessionId = string;

export type ProxySessionStatus = 'starting' | 'active' | 'stopping' | 'stopped';

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
}

// ---------------------------------------------------------------------------
// Policy engine types
// ---------------------------------------------------------------------------

import type { CredentialInjectionTemplate } from '../../credentials/policy-types.js';

/** A single credential matched — inject it. */
export interface PolicyDecisionMatched {
  kind: 'matched';
  credentialId: string;
  template: CredentialInjectionTemplate;
}

/** Multiple credentials match — caller must disambiguate. */
export interface PolicyDecisionAmbiguous {
  kind: 'ambiguous';
  candidates: Array<{ credentialId: string; template: CredentialInjectionTemplate }>;
}

/** No credential matches the target host/path. */
export interface PolicyDecisionMissing {
  kind: 'missing';
}

/** No credential_ids were requested — pass-through. */
export interface PolicyDecisionUnauthenticated {
  kind: 'unauthenticated';
}

// ---------------------------------------------------------------------------
// Approval hook outcomes — structured data for triggering permission prompts.
// The actual prompt UI wiring happens in a later PR.
// ---------------------------------------------------------------------------

/** Context about the outbound request target, used to build permission prompts. */
export interface RequestTargetContext {
  hostname: string;
  port: number | null;
  path: string;
}

/**
 * The target host matches a known credential template pattern, but the
 * session has no credential bound for it. The UI should prompt the user
 * to bind or create a credential.
 */
export interface PolicyDecisionAskMissingCredential {
  kind: 'ask_missing_credential';
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
  kind: 'ask_unauthenticated';
  target: RequestTargetContext;
}

export type PolicyDecision =
  | PolicyDecisionMatched
  | PolicyDecisionAmbiguous
  | PolicyDecisionMissing
  | PolicyDecisionUnauthenticated
  | PolicyDecisionAskMissingCredential
  | PolicyDecisionAskUnauthenticated;
