/**
 * Managed subject resolution for platform OAuth handles.
 *
 * Resolves `platform_oauth:<connection_id>` handles into a normalized
 * subject shape that the rest of CES can treat uniformly alongside local
 * subjects. Managed subjects never carry raw tokens — they carry only
 * the metadata needed to call the platform's token-materialization
 * endpoint at execution time.
 *
 * Subject resolution is the first phase of a two-phase credential flow:
 *   1. **Resolution** (this module) — parse the handle, validate the
 *      connection exists in the platform catalog, and return a subject
 *      descriptor with provider metadata.
 *   2. **Materialization** (`materializers/managed-platform.ts`) — use
 *      the resolved subject to request a short-lived access token from
 *      the platform and inject it into the execution environment.
 *
 * The subject shape is intentionally slim and secret-free so it can be
 * logged, cached in memory, and passed across internal boundaries without
 * risk of leaking credentials.
 */

import {
  HandleType,
  parseHandle,
  type PlatformOAuthHandle,
} from "@vellumai/ces-contracts";

// ---------------------------------------------------------------------------
// Common subject interface
// ---------------------------------------------------------------------------

/**
 * Source discriminator shared by all subject types.
 *
 * - `"local"` — credential lives in the local secure-key backend.
 * - `"managed"` — credential is managed by the platform; tokens are
 *   obtained via the platform's CES token-materialization endpoint.
 */
export type SubjectSource = "local" | "managed";

/**
 * Common shape that all resolved subjects expose. CES execution paths
 * (HTTP materializer, command materializer) can branch on `source`
 * without knowing the full subject type.
 */
export interface ResolvedSubject {
  /** Source of the credential. */
  source: SubjectSource;
  /** The raw handle string that was resolved. */
  handle: string;
  /** Provider identifier (e.g. "google", "slack", "github"). */
  provider: string;
  /** Connection identifier on the platform (managed) or locally. */
  connectionId: string;
}

// ---------------------------------------------------------------------------
// Managed subject shape
// ---------------------------------------------------------------------------

/**
 * A resolved managed subject — the output of resolving a
 * `platform_oauth:<connection_id>` handle against the platform catalog.
 *
 * This shape carries zero secret material. It is safe to log, serialize,
 * and pass across internal boundaries.
 */
export interface ManagedSubject extends ResolvedSubject {
  source: "managed";
  /** Account info as reported by the platform catalog (e.g. email). */
  accountInfo: string | null;
  /** Granted OAuth scopes as reported by the platform catalog. */
  grantedScopes: string[];
  /** Connection status from the platform catalog (e.g. "active", "expired"). */
  status: string;
}

// ---------------------------------------------------------------------------
// Platform catalog entry (non-secret subset from the platform response)
// ---------------------------------------------------------------------------

/**
 * Shape of a single connection entry in the platform catalog response.
 * Only non-secret fields are parsed; token values are never included.
 */
export interface PlatformCatalogEntry {
  id: string;
  provider: string;
  account_info?: string | null;
  granted_scopes?: string[];
  status?: string;
}

// ---------------------------------------------------------------------------
// Resolution errors
// ---------------------------------------------------------------------------

export class SubjectResolutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SubjectResolutionError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Resolution options
// ---------------------------------------------------------------------------

export interface ManagedSubjectResolverOptions {
  /**
   * Platform base URL (without trailing slash).
   * e.g. "https://api.vellum.ai"
   */
  platformBaseUrl: string;
  /**
   * Assistant API key for authenticating with the platform.
   */
  assistantApiKey: string;
  /**
   * Optional custom fetch implementation (for testing).
   */
  fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Resolution result
// ---------------------------------------------------------------------------

export type ResolveResult =
  | { ok: true; subject: ManagedSubject }
  | { ok: false; error: SubjectResolutionError };

// ---------------------------------------------------------------------------
// Resolver implementation
// ---------------------------------------------------------------------------

/**
 * Resolve a `platform_oauth:<connection_id>` handle into a managed subject
 * by looking up the connection in the platform's CES catalog.
 *
 * Fail-closed: if the platform cannot be reached, returns an error rather
 * than proceeding without credential validation.
 */
export async function resolveManagedSubject(
  handle: string,
  options: ManagedSubjectResolverOptions,
): Promise<ResolveResult> {
  // -- Parse handle ---------------------------------------------------------
  const parsed = parseHandle(handle);
  if (!parsed.ok) {
    return {
      ok: false,
      error: new SubjectResolutionError("INVALID_HANDLE", parsed.error),
    };
  }

  if (parsed.handle.type !== HandleType.PlatformOAuth) {
    return {
      ok: false,
      error: new SubjectResolutionError(
        "WRONG_HANDLE_TYPE",
        `Expected platform_oauth handle, got ${parsed.handle.type}`,
      ),
    };
  }

  const platformHandle = parsed.handle as PlatformOAuthHandle;

  // -- Validate prerequisites -----------------------------------------------
  if (!options.platformBaseUrl) {
    return {
      ok: false,
      error: new SubjectResolutionError(
        "MISSING_PLATFORM_URL",
        "Platform base URL is required for managed subject resolution",
      ),
    };
  }

  if (!options.assistantApiKey) {
    return {
      ok: false,
      error: new SubjectResolutionError(
        "MISSING_API_KEY",
        "Assistant API key is required for managed subject resolution",
      ),
    };
  }

  // -- Fetch catalog entry --------------------------------------------------
  const fetchFn = options.fetch ?? globalThis.fetch;
  const catalogUrl = `${options.platformBaseUrl}/v1/ces/catalog`;

  let response: Response;
  try {
    response = await fetchFn(catalogUrl, {
      method: "GET",
      headers: {
        Authorization: `Api-Key ${options.assistantApiKey}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new SubjectResolutionError(
        "PLATFORM_UNREACHABLE",
        `Failed to reach platform CES catalog: ${sanitizeError(message)}`,
      ),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: new SubjectResolutionError(
        `PLATFORM_HTTP_${response.status}`,
        `Platform CES catalog returned HTTP ${response.status}`,
      ),
    };
  }

  // -- Parse response -------------------------------------------------------
  let body: { connections?: PlatformCatalogEntry[] };
  try {
    body = (await response.json()) as { connections?: PlatformCatalogEntry[] };
  } catch {
    return {
      ok: false,
      error: new SubjectResolutionError(
        "INVALID_CATALOG_RESPONSE",
        "Platform CES catalog returned invalid JSON",
      ),
    };
  }

  if (!body.connections || !Array.isArray(body.connections)) {
    return {
      ok: false,
      error: new SubjectResolutionError(
        "INVALID_CATALOG_RESPONSE",
        "Platform CES catalog returned unexpected response format",
      ),
    };
  }

  // -- Find matching connection ---------------------------------------------
  const entry = body.connections.find(
    (c) => c.id === platformHandle.connectionId,
  );

  if (!entry) {
    return {
      ok: false,
      error: new SubjectResolutionError(
        "CONNECTION_NOT_FOUND",
        `Connection ${platformHandle.connectionId} not found in platform catalog`,
      ),
    };
  }

  // -- Build managed subject ------------------------------------------------
  const subject: ManagedSubject = {
    source: "managed",
    handle,
    provider: entry.provider,
    connectionId: entry.id,
    accountInfo: entry.account_info ?? null,
    grantedScopes: entry.granted_scopes ?? [],
    status: entry.status ?? "unknown",
  };

  return { ok: true, subject };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize error messages to avoid leaking secrets (defensive).
 */
function sanitizeError(message: string): string {
  return message.replace(/Api-Key\s+\S+/gi, "Api-Key [REDACTED]");
}
