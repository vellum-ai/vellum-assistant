/**
 * HTTP executor for the Credential Execution Service.
 *
 * Implements the full `make_authenticated_request` flow:
 *
 * 1. Resolve the credential handle to a local or managed subject.
 * 2. Check grants (policy evaluation) — block off-grant requests before
 *    any network call.
 * 3. Materialise the credential through the appropriate backend.
 * 4. Inject auth into the outbound request according to the subject's
 *    handle type.
 * 5. Perform the HTTP request.
 * 6. Reject redirect hops that would violate the grant policy.
 * 7. Filter the response through the PR 21 sanitisation pipeline.
 * 8. Generate a token-free audit summary.
 *
 * Security invariants:
 * - Off-grant requests never reach the network.
 * - Caller-supplied raw auth headers are rejected.
 * - Redirect hops to domains/paths outside the grant's scope are blocked.
 * - The assistant runtime only sees sanitised HTTP results and audit
 *   summaries — never raw tokens or secrets.
 * - Audit summaries are always token-free.
 */

import type {
  MakeAuthenticatedRequest,
  MakeAuthenticatedRequestResponse,
} from "@vellumai/ces-contracts";
import { HandleType, parseHandle, hashProposal } from "@vellumai/ces-contracts";

import { evaluateHttpPolicy, type PolicyResult } from "./policy.js";
import { filterHttpResponse, type RawHttpResponse } from "./response-filter.js";
import { generateHttpAuditSummary } from "./audit.js";

import type { PersistentGrantStore } from "../grants/persistent-store.js";
import type { TemporaryGrantStore } from "../grants/temporary-store.js";

import type { LocalMaterialiser, MaterialisedCredential } from "../materializers/local.js";
import { materializeManagedToken, type ManagedMaterializerOptions } from "../materializers/managed-platform.js";
import { resolveLocalSubject, type LocalSubjectResolverDeps } from "../subjects/local.js";
import { resolveManagedSubject, type ManagedSubjectResolverOptions } from "../subjects/managed.js";

// ---------------------------------------------------------------------------
// Auth injection constants
// ---------------------------------------------------------------------------

/**
 * Headers that are forbidden in caller-supplied requests. This is
 * enforced at the policy layer, but we double-check before injection
 * as defense-in-depth.
 */
const AUTH_HEADERS_TO_STRIP = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
]);

// ---------------------------------------------------------------------------
// Executor dependencies
// ---------------------------------------------------------------------------

export interface HttpExecutorDeps {
  /** Persistent grant store for policy evaluation. */
  persistentGrantStore: PersistentGrantStore;
  /** Temporary grant store for policy evaluation. */
  temporaryGrantStore: TemporaryGrantStore;
  /** Local materialiser for local_static and local_oauth handles. */
  localMaterialiser: LocalMaterialiser;
  /** Dependencies for local subject resolution. */
  localSubjectDeps: LocalSubjectResolverDeps;
  /** Options for managed subject resolution (null if managed mode is unavailable). */
  managedSubjectOptions?: ManagedSubjectResolverOptions;
  /** Options for managed token materialisation (null if managed mode is unavailable). */
  managedMaterializerOptions?: ManagedMaterializerOptions;
  /** Session ID for audit records. */
  sessionId: string;
  /** Optional custom fetch implementation (for testing). */
  fetch?: typeof globalThis.fetch;
  /** Optional logger. */
  logger?: Pick<Console, "log" | "warn" | "error">;
}

// ---------------------------------------------------------------------------
// Redirect policy
// ---------------------------------------------------------------------------

/**
 * Maximum number of redirects to follow before aborting.
 */
const MAX_REDIRECTS = 5;

/**
 * HTTP status codes that indicate a redirect.
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// ---------------------------------------------------------------------------
// Executor implementation
// ---------------------------------------------------------------------------

/**
 * Execute an authenticated HTTP request through the full CES pipeline.
 *
 * This is the handler implementation for the `make_authenticated_request`
 * RPC method. It is pure logic with injected dependencies, making it
 * testable without real network calls or credential stores.
 */
export async function executeAuthenticatedHttpRequest(
  request: MakeAuthenticatedRequest,
  deps: HttpExecutorDeps,
): Promise<MakeAuthenticatedRequestResponse> {
  const logger = deps.logger ?? console;

  // 1. Parse the handle to determine source (local vs managed)
  const parseResult = parseHandle(request.credentialHandle);
  if (!parseResult.ok) {
    return {
      success: false,
      error: {
        code: "INVALID_HANDLE",
        message: parseResult.error,
      },
    };
  }

  // 2. Evaluate grant policy — blocks off-grant requests before network
  const policyResult = evaluateHttpPolicy(
    {
      credentialHandle: request.credentialHandle,
      method: request.method,
      url: request.url,
      headers: request.headers,
      purpose: request.purpose,
      grantId: request.grantId,
    },
    deps.persistentGrantStore,
    deps.temporaryGrantStore,
  );

  if (!policyResult.allowed) {
    if (policyResult.reason === "forbidden_headers") {
      return {
        success: false,
        error: {
          code: "FORBIDDEN_HEADERS",
          message: `Request contains forbidden auth headers that the agent must not set: ${policyResult.forbiddenHeaders.join(", ")}. CES injects authentication — the caller must not supply raw auth headers.`,
        },
      };
    }

    // approval_required — return the proposal so the assistant can prompt
    return {
      success: false,
      error: {
        code: "APPROVAL_REQUIRED",
        message: `No active grant covers this request. Approval is required.`,
        details: {
          proposal: policyResult.proposal,
          proposalHash: hashProposal(policyResult.proposal),
        },
      },
    };
  }

  const grantId = policyResult.grantId;

  // 3. Materialise the credential
  const materialiseResult = await materialiseCredential(
    parseResult.handle.type,
    request.credentialHandle,
    deps,
  );

  if (!materialiseResult.ok) {
    const audit = generateHttpAuditSummary({
      credentialHandle: request.credentialHandle,
      grantId,
      sessionId: deps.sessionId,
      method: request.method,
      url: request.url,
      success: false,
      errorMessage: materialiseResult.error,
    });

    return {
      success: false,
      error: {
        code: "MATERIALISATION_FAILED",
        message: materialiseResult.error,
      },
      auditId: audit.auditId,
    };
  }

  const { credential, secrets } = materialiseResult;

  // 4. Build the outbound request with injected auth
  const outboundHeaders = buildOutboundHeaders(
    request.headers ?? {},
    credential,
  );

  // 5. Perform the HTTP request with redirect enforcement
  let rawResponse: RawHttpResponse;
  try {
    rawResponse = await performHttpRequest(
      request.method,
      request.url,
      outboundHeaders,
      request.body,
      policyResult,
      request.credentialHandle,
      deps,
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // Sanitise error messages to avoid leaking secrets
    const safeError = sanitiseErrorMessage(errorMessage, secrets);

    const audit = generateHttpAuditSummary({
      credentialHandle: request.credentialHandle,
      grantId,
      sessionId: deps.sessionId,
      method: request.method,
      url: request.url,
      success: false,
      errorMessage: safeError,
    });

    return {
      success: false,
      error: {
        code: "HTTP_REQUEST_FAILED",
        message: safeError,
      },
      auditId: audit.auditId,
    };
  }

  // 6. Filter the response through the sanitisation pipeline
  const filtered = filterHttpResponse(rawResponse, secrets);

  // 7. Generate audit summary
  const audit = generateHttpAuditSummary({
    credentialHandle: request.credentialHandle,
    grantId,
    sessionId: deps.sessionId,
    method: request.method,
    url: request.url,
    success: true,
    statusCode: rawResponse.statusCode,
  });

  logger.log(
    `[ces-http] ${request.method} ${request.url} -> ${rawResponse.statusCode} (grant=${grantId})`,
  );

  return {
    success: true,
    statusCode: filtered.statusCode,
    responseHeaders: filtered.headers,
    responseBody: filtered.body,
    auditId: audit.auditId,
  };
}

// ---------------------------------------------------------------------------
// Credential materialisation dispatch
// ---------------------------------------------------------------------------

interface MaterialiseSuccess {
  ok: true;
  credential: MaterialisedCredential;
  /** Secret values to scrub from response bodies (defense-in-depth). */
  secrets: string[];
}

interface MaterialiseFailure {
  ok: false;
  error: string;
}

type MaterialiseResult = MaterialiseSuccess | MaterialiseFailure;

async function materialiseCredential(
  handleType: string,
  rawHandle: string,
  deps: HttpExecutorDeps,
): Promise<MaterialiseResult> {
  switch (handleType) {
    case HandleType.LocalStatic:
    case HandleType.LocalOAuth: {
      // Resolve local subject
      const subjectResult = resolveLocalSubject(rawHandle, deps.localSubjectDeps);
      if (!subjectResult.ok) {
        return { ok: false, error: subjectResult.error };
      }

      // Materialise through the local materialiser
      const matResult = await deps.localMaterialiser.materialise(subjectResult.subject);
      if (!matResult.ok) {
        return { ok: false, error: matResult.error };
      }

      return {
        ok: true,
        credential: matResult.credential,
        secrets: [matResult.credential.value],
      };
    }

    case HandleType.PlatformOAuth: {
      if (!deps.managedSubjectOptions || !deps.managedMaterializerOptions) {
        return {
          ok: false,
          error: "Managed OAuth is not configured. Platform URL and API key are required.",
        };
      }

      // Resolve managed subject
      const subjectResult = await resolveManagedSubject(
        rawHandle,
        deps.managedSubjectOptions,
      );
      if (!subjectResult.ok) {
        return { ok: false, error: subjectResult.error.message };
      }

      // Materialise through the managed materialiser
      const matResult = await materializeManagedToken(
        subjectResult.subject,
        deps.managedMaterializerOptions,
      );
      if (!matResult.ok) {
        return { ok: false, error: matResult.error.message };
      }

      return {
        ok: true,
        credential: {
          value: matResult.token.accessToken,
          handleType: HandleType.PlatformOAuth,
          expiresAt: matResult.token.expiresAt,
        },
        secrets: [matResult.token.accessToken],
      };
    }

    default:
      return {
        ok: false,
        error: `Unsupported handle type "${handleType}" for HTTP execution`,
      };
  }
}

// ---------------------------------------------------------------------------
// Auth header injection
// ---------------------------------------------------------------------------

/**
 * Build the outbound request headers by:
 * 1. Stripping any caller-supplied auth headers (defense-in-depth).
 * 2. Injecting the credential as an Authorization header.
 */
function buildOutboundHeaders(
  callerHeaders: Record<string, string>,
  credential: MaterialisedCredential,
): Record<string, string> {
  const headers: Record<string, string> = {};

  // Copy caller headers, stripping any auth headers
  for (const [key, value] of Object.entries(callerHeaders)) {
    if (!AUTH_HEADERS_TO_STRIP.has(key.toLowerCase())) {
      headers[key] = value;
    }
  }

  // Inject credential based on handle type
  switch (credential.handleType) {
    case HandleType.LocalStatic:
      // Static secrets are injected as Bearer tokens by default.
      // The subject metadata could specify a different injection strategy
      // in the future, but for now Bearer is the safe default.
      headers["Authorization"] = `Bearer ${credential.value}`;
      break;

    case HandleType.LocalOAuth:
    case HandleType.PlatformOAuth:
      // OAuth tokens are always Bearer tokens.
      headers["Authorization"] = `Bearer ${credential.value}`;
      break;

    default:
      // Unknown type — inject as Bearer (fail-open on injection is OK
      // because the grant policy already vetted the request).
      headers["Authorization"] = `Bearer ${credential.value}`;
      break;
  }

  return headers;
}

// ---------------------------------------------------------------------------
// HTTP request execution with redirect enforcement
// ---------------------------------------------------------------------------

/**
 * Perform an HTTP request, following redirects only when each hop
 * independently satisfies the grant policy.
 */
async function performHttpRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: unknown | undefined,
  originalPolicy: PolicyResult & { allowed: true },
  credentialHandle: string,
  deps: HttpExecutorDeps,
): Promise<RawHttpResponse> {
  const fetchFn = deps.fetch ?? globalThis.fetch;

  let currentUrl = url;
  let currentMethod = method;
  let currentHeaders = headers;
  let currentBody = body;
  let redirectCount = 0;

  while (true) {
    // Build fetch options — disable automatic redirect following so we
    // can enforce grant policy on each hop.
    const fetchOptions: RequestInit = {
      method: currentMethod,
      headers: currentHeaders,
      redirect: "manual",
    };

    if (currentBody !== undefined && currentBody !== null) {
      fetchOptions.body =
        typeof currentBody === "string"
          ? currentBody
          : JSON.stringify(currentBody);
    }

    const response = await fetchFn(currentUrl, fetchOptions);

    // Check for redirect
    if (REDIRECT_STATUSES.has(response.status)) {
      redirectCount++;
      if (redirectCount > MAX_REDIRECTS) {
        throw new Error(
          `Too many redirects (exceeded ${MAX_REDIRECTS}). Aborting.`,
        );
      }

      const locationHeader = response.headers.get("location");
      if (!locationHeader) {
        throw new Error(
          `Redirect response (${response.status}) missing Location header.`,
        );
      }

      // Resolve the redirect URL (may be relative)
      const redirectUrl = new URL(locationHeader, currentUrl).toString();

      // Enforce grant policy on the redirect target — the redirect must
      // independently satisfy the same credential handle's grant policy.
      const redirectPolicy = evaluateHttpPolicy(
        {
          credentialHandle,
          method: currentMethod,
          url: redirectUrl,
          purpose: `redirect from ${currentUrl}`,
        },
        deps.persistentGrantStore,
        deps.temporaryGrantStore,
      );

      if (!redirectPolicy.allowed) {
        throw new Error(
          `Redirect to ${sanitiseUrl(redirectUrl)} denied: the redirect target does not satisfy the grant policy for credential handle "${credentialHandle}".`,
        );
      }

      // For 303 redirects, convert to GET
      if (response.status === 303) {
        currentMethod = "GET";
        currentBody = undefined;
      }

      currentUrl = redirectUrl;
      continue;
    }

    // Not a redirect — read the response
    const responseBody = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      statusCode: response.status,
      headers: responseHeaders,
      body: responseBody,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitise a URL for error messages by stripping query parameters
 * (which may contain sensitive values).
 */
function sanitiseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

/**
 * Sanitise error messages to avoid leaking secret values.
 */
function sanitiseErrorMessage(message: string, secrets: string[]): string {
  let result = message;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    result = result.replaceAll(secret, "[CES:REDACTED]");
  }
  return result;
}
