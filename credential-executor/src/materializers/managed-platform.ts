/**
 * Managed platform OAuth materializer.
 *
 * Materializes a `platform_oauth` handle into a short-lived access token
 * by calling the platform's CES token-materialization endpoint. The
 * materialized token is returned to the caller for immediate use (e.g.
 * injection into an HTTP request or command environment) but is **never**
 * persisted to any local storage — it exists only in memory for the
 * duration of the execution.
 *
 * Security invariants:
 * - Materialized tokens are never written to disk.
 * - Materialized tokens are never logged (not even partially).
 * - Platform errors are surfaced as structured errors without leaking secrets.
 * - If the platform cannot be reached, materialization fails closed.
 *
 * The materializer expects a resolved `ManagedSubject` from
 * `subjects/managed.ts`. It does not perform handle parsing or catalog
 * lookup — that is the resolver's responsibility.
 */

import type { ManagedSubject } from "../subjects/managed.js";

// ---------------------------------------------------------------------------
// Materialization result
// ---------------------------------------------------------------------------

/**
 * Successful materialization result.
 *
 * The `accessToken` field contains the short-lived token obtained from
 * the platform. Callers MUST NOT persist this value — it should be used
 * immediately for request injection and then discarded.
 */
export interface MaterializedToken {
  /** The short-lived access token. */
  accessToken: string;
  /** Token type (typically "Bearer"). */
  tokenType: string;
  /** Epoch ms when the token expires (null if the platform didn't report expiry). */
  expiresAt: number | null;
  /** Provider key (mirrored from the subject for convenience). */
  provider: string;
  /** Connection ID (mirrored from the subject for convenience). */
  connectionId: string;
}

export type MaterializeResult =
  | { ok: true; token: MaterializedToken }
  | { ok: false; error: MaterializationError };

// ---------------------------------------------------------------------------
// Materialization errors
// ---------------------------------------------------------------------------

export class MaterializationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MaterializationError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Platform token response shape
// ---------------------------------------------------------------------------

/**
 * Shape of the platform's CES token-materialization response.
 *
 * Field names match the platform's ManagedTokenMaterializeResponseSerializer:
 *   access_token, token_type, expires_at, provider, handle
 *
 * The platform issues a short-lived access token for the specified
 * connection. The token is pre-authorized for the scopes granted on
 * the connection.
 */
interface PlatformTokenResponse {
  access_token: string;
  token_type?: string;
  /** ISO-8601 datetime when the token expires (null if no expiry). */
  expires_at?: string | null;
  provider?: string;
  handle?: string;
}

// ---------------------------------------------------------------------------
// Materializer options
// ---------------------------------------------------------------------------

export interface ManagedMaterializerOptions {
  /**
   * Platform base URL (without trailing slash).
   */
  platformBaseUrl: string;
  /**
   * Assistant API key for authenticating with the platform.
   */
  assistantApiKey: string;
  /**
   * Platform-assigned assistant UUID. Required for building the
   * platform materialize URL: /v1/assistants/<id>/oauth/managed/materialize/
   */
  assistantId: string;
  /**
   * Optional custom fetch implementation (for testing).
   */
  fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Materializer implementation
// ---------------------------------------------------------------------------

/**
 * Materialize a managed OAuth subject into a short-lived access token
 * by calling the platform's token-materialization endpoint.
 *
 * The endpoint is:
 *   POST {platformBaseUrl}/v1/assistants/{assistantId}/oauth/managed/materialize/
 *
 * The request body contains `{ connection_id: <uuid> }`.
 *
 * The platform validates the assistant API key, checks that the connection
 * is active, and returns a fresh access token (refreshing upstream if
 * needed).
 *
 * Fail-closed: any error results in a structured `MaterializationError`
 * rather than a partial or fallback result.
 */
export async function materializeManagedToken(
  subject: ManagedSubject,
  options: ManagedMaterializerOptions
): Promise<MaterializeResult> {
  // -- Validate prerequisites -----------------------------------------------
  if (!options.platformBaseUrl) {
    return {
      ok: false,
      error: new MaterializationError(
        "MISSING_PLATFORM_URL",
        "Platform base URL is required for managed token materialization"
      ),
    };
  }

  if (!options.assistantApiKey) {
    return {
      ok: false,
      error: new MaterializationError(
        "MISSING_API_KEY",
        "Assistant API key is required for managed token materialization"
      ),
    };
  }

  if (!options.assistantId) {
    return {
      ok: false,
      error: new MaterializationError(
        "MISSING_ASSISTANT_ID",
        "Assistant ID is required for managed token materialization"
      ),
    };
  }

  // -- Call platform token endpoint -----------------------------------------
  const fetchFn = options.fetch ?? globalThis.fetch;
  const materializeUrl = `${
    options.platformBaseUrl
  }/v1/assistants/${encodeURIComponent(
    options.assistantId
  )}/oauth/managed/materialize/`;

  let response: Response;
  try {
    response = await fetchFn(materializeUrl, {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${options.assistantApiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ connection_id: subject.connectionId }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new MaterializationError(
        "PLATFORM_UNREACHABLE",
        `Failed to reach platform token endpoint: ${sanitizeError(message)}`
      ),
    };
  }

  // -- Handle error responses -----------------------------------------------
  if (!response.ok) {
    return {
      ok: false,
      error: mapPlatformError(response.status, subject.connectionId),
    };
  }

  // -- Parse token response -------------------------------------------------
  let body: PlatformTokenResponse;
  try {
    body = (await response.json()) as PlatformTokenResponse;
  } catch {
    return {
      ok: false,
      error: new MaterializationError(
        "INVALID_TOKEN_RESPONSE",
        "Platform token endpoint returned invalid JSON"
      ),
    };
  }

  if (!body.access_token || typeof body.access_token !== "string") {
    return {
      ok: false,
      error: new MaterializationError(
        "INVALID_TOKEN_RESPONSE",
        "Platform token response missing access_token"
      ),
    };
  }

  // -- Build materialized token ---------------------------------------------
  const expiresAt = parseExpiresAt(body.expires_at);

  const token: MaterializedToken = {
    accessToken: body.access_token,
    tokenType: body.token_type ?? "Bearer",
    expiresAt,
    provider: subject.provider,
    connectionId: subject.connectionId,
  };

  return { ok: true, token };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a platform HTTP error status to a structured MaterializationError.
 */
function mapPlatformError(
  status: number,
  connectionId: string
): MaterializationError {
  switch (status) {
    case 401:
      return new MaterializationError(
        "PLATFORM_AUTH_FAILED",
        "Assistant API key is invalid or expired (HTTP 401)"
      );
    case 403:
      return new MaterializationError(
        "PLATFORM_FORBIDDEN",
        "Assistant is not authorized to materialize this connection (HTTP 403)"
      );
    case 404:
      return new MaterializationError(
        "CONNECTION_NOT_FOUND",
        `Connection ${connectionId} not found on the platform (HTTP 404)`
      );
    default:
      return new MaterializationError(
        `PLATFORM_HTTP_${status}`,
        `Platform token endpoint returned HTTP ${status}`
      );
  }
}

/**
 * Parse an ISO-8601 `expires_at` datetime string into epoch milliseconds.
 * Returns null if the value is missing or invalid.
 */
function parseExpiresAt(expiresAt: string | null | undefined): number | null {
  if (expiresAt == null) return null;
  const ts = new Date(expiresAt).getTime();
  if (Number.isNaN(ts)) return null;
  return ts;
}

/**
 * Sanitize error messages to avoid leaking secrets.
 */
function sanitizeError(message: string): string {
  return message.replace(/Api-Key\s+\S+/gi, "Api-Key [REDACTED]");
}
