/**
 * HTTP policy evaluation for the Credential Execution Service.
 *
 * Evaluates incoming HTTP requests against the CES grant stores before any
 * outbound network call is made. If no active grant covers the request, the
 * policy engine blocks the call and returns an `approval_required` result
 * containing the minimal reusable HTTP capability proposal.
 *
 * Security invariants:
 * - **Off-grant requests are blocked before any network call.** The CES must
 *   never make an authenticated outbound HTTP request without a matching grant.
 * - **Proposal derivation never auto-expands.** Proposals use the concrete
 *   path template (with typed placeholders for dynamic segments), never host
 *   wildcards or `/*`.
 * - **Caller-supplied auth headers are rejected.** The untrusted agent must
 *   not be able to smuggle raw `Authorization`, `Cookie`, or other auth
 *   headers in the request — CES injects those from the materialised
 *   credential.
 */

import { hashProposal, type HttpGrantProposal } from "@vellumai/ces-contracts";

import type { PersistentGrant, PersistentGrantStore } from "../grants/persistent-store.js";
import type { TemporaryGrantStore } from "../grants/temporary-store.js";
import {
  deriveAllowedUrlPatterns,
  derivePathTemplate,
  urlMatchesTemplate,
} from "./path-template.js";

// ---------------------------------------------------------------------------
// Auth header rejection
// ---------------------------------------------------------------------------

/**
 * Headers that the untrusted agent is forbidden from setting on credentialed
 * requests. CES injects authentication; the caller must not override it.
 */
const FORBIDDEN_CALLER_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
]);

/**
 * Returns the list of forbidden header names present in the caller-supplied
 * headers, or an empty array if none are present.
 */
export function detectForbiddenHeaders(
  headers: Record<string, string> | undefined,
): string[] {
  if (!headers) return [];
  const forbidden: string[] = [];
  for (const key of Object.keys(headers)) {
    if (FORBIDDEN_CALLER_HEADERS.has(key.toLowerCase())) {
      forbidden.push(key);
    }
  }
  return forbidden;
}

// ---------------------------------------------------------------------------
// Policy evaluation result
// ---------------------------------------------------------------------------

export type PolicyResult =
  | { allowed: true; grantId: string; grantSource: "persistent" | "temporary" }
  | { allowed: false; reason: "forbidden_headers"; forbiddenHeaders: string[] }
  | {
      allowed: false;
      reason: "approval_required";
      proposal: HttpGrantProposal;
    };

// ---------------------------------------------------------------------------
// Policy evaluation request
// ---------------------------------------------------------------------------

export interface HttpPolicyRequest {
  /** CES credential handle identifying which credential to use. */
  credentialHandle: string;
  /** HTTP method (e.g. "GET", "POST"). */
  method: string;
  /** Target URL. */
  url: string;
  /** Caller-supplied headers (before credential injection). */
  headers?: Record<string, string>;
  /** Human-readable purpose for the audit trail. */
  purpose: string;
  /** Explicit grant ID the caller claims to hold. */
  grantId?: string;
  /** Conversation ID for thread-scoped temporary grants. */
  conversationId?: string;
}

// ---------------------------------------------------------------------------
// Policy evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate whether an HTTP request is covered by an existing grant.
 *
 * Evaluation order:
 * 1. Reject forbidden caller-supplied auth headers.
 * 2. If an explicit `grantId` is provided, look it up in the persistent store.
 * 3. Check the persistent grant store for a matching active grant.
 * 4. Check the temporary grant store for a matching temporary grant.
 * 5. If no grant matches, derive a minimal proposal and return `approval_required`.
 */
export function evaluateHttpPolicy(
  request: HttpPolicyRequest,
  persistentStore: PersistentGrantStore,
  temporaryStore: TemporaryGrantStore,
): PolicyResult {
  // 1. Reject forbidden caller-supplied auth headers
  const forbidden = detectForbiddenHeaders(request.headers);
  if (forbidden.length > 0) {
    return {
      allowed: false,
      reason: "forbidden_headers",
      forbiddenHeaders: forbidden,
    };
  }

  // 2. Check explicit grantId in persistent store
  if (request.grantId) {
    const grant = persistentStore.getById(request.grantId);
    if (
      grant &&
      grant.tool === "http" &&
      grantCoversRequest(grant, request.credentialHandle, request.method, request.url, "")
    ) {
      return { allowed: true, grantId: grant.id, grantSource: "persistent" };
    }
    // Explicit grant not found or does not cover this request — fall through to pattern matching
  }

  // 3. Check persistent grants for pattern match
  const pathTemplate = derivePathTemplate(request.url);
  const allGrants = persistentStore.getAll();
  for (const grant of allGrants) {
    if (
      grant.tool === "http" &&
      grantCoversRequest(grant, request.credentialHandle, request.method, request.url, pathTemplate)
    ) {
      return { allowed: true, grantId: grant.id, grantSource: "persistent" };
    }
  }

  // 4. Check temporary grants
  // Build a proposal hash key from the canonical request shape
  const proposal = buildProposal(request, pathTemplate);
  const proposalHash = hashProposal(proposal);

  const tempKind = temporaryStore.checkAny(
    proposalHash,
    request.conversationId,
  );
  if (tempKind) {
    return {
      allowed: true,
      grantId: `temp:${tempKind}:${proposalHash}`,
      grantSource: "temporary",
    };
  }

  // 5. No grant matches — derive proposal
  return {
    allowed: false,
    reason: "approval_required",
    proposal,
  };
}

// ---------------------------------------------------------------------------
// Grant matching helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a persistent grant covers a specific HTTP request.
 *
 * A grant covers a request when:
 * - The grant's `pattern` field contains an `allowedUrlPatterns`-style
 *   entry that matches the request URL's path template.
 * - The grant's `scope` field matches the credential handle.
 * - The grant is for the `http` tool type.
 */
function grantCoversRequest(
  grant: PersistentGrant,
  credentialHandle: string,
  method: string,
  rawUrl: string,
  _pathTemplate: string,
): boolean {
  // Scope must match the credential handle
  if (grant.scope !== credentialHandle) return false;

  // The pattern field encodes "METHOD pattern", e.g. "GET https://api.github.com/repos/{:uuid}/pulls"
  // Parse out the method and URL pattern
  const spaceIdx = grant.pattern.indexOf(" ");
  if (spaceIdx === -1) {
    // Pattern without method — match URL only
    return urlMatchesTemplate(rawUrl, grant.pattern);
  }

  const grantMethod = grant.pattern.slice(0, spaceIdx).toUpperCase();
  const grantUrlPattern = grant.pattern.slice(spaceIdx + 1);

  if (grantMethod !== method.toUpperCase()) return false;
  return urlMatchesTemplate(rawUrl, grantUrlPattern);
}

// ---------------------------------------------------------------------------
// Proposal construction
// ---------------------------------------------------------------------------

/**
 * Build the minimal HTTP grant proposal for an unapproved request.
 *
 * The proposal uses the derived path template as the `allowedUrlPatterns`
 * entry — never `/*` or host-level wildcards.
 */
function buildProposal(
  request: HttpPolicyRequest,
  _pathTemplate: string,
): HttpGrantProposal {
  return {
    type: "http",
    credentialHandle: request.credentialHandle,
    method: request.method.toUpperCase(),
    url: request.url,
    purpose: request.purpose,
    allowedUrlPatterns: deriveAllowedUrlPatterns(request.url),
  };
}

