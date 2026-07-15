/**
 * Authenticated fetch for plugin authors.
 *
 * Resolves a credential by matching the request hostname against each
 * credential's `injectionTemplates.hostPattern` (same matching rules as the
 * script-proxy MITM path), checks that the credential allows the
 * `authedFetch` capability, builds the injected header value (never exposing
 * the plaintext to the caller), then performs a normal `fetch`.
 */

import { evaluateRequest } from "../outbound-proxy/policy.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { buildInjectedValue } from "../tools/credentials/injection.js";
import { listCredentialMetadata } from "../tools/credentials/metadata-store.js";
import type { CredentialInjectionTemplate } from "../tools/credentials/policy-types.js";
import {
  resolveById,
  resolveCredentialRef,
  type ResolvedCredential,
} from "../tools/credentials/resolve.js";
import {
  AUTHED_FETCH_CAPABILITY,
  isToolAllowed,
} from "../tools/credentials/tool-policy.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("plugin-api:authed-fetch");

// ---------------------------------------------------------------------------
// Public options / errors
// ---------------------------------------------------------------------------

export interface AuthedFetchOptions {
  /**
   * Pin a credential by opaque id or `service/field`. When omitted, every
   * credential with injection templates is considered and the best
   * hostPattern match wins (ambiguity throws).
   */
  credential?: string;
}

export type AuthedFetchErrorCode =
  | "MISSING_URL"
  | "NO_CREDENTIAL"
  | "AMBIGUOUS_CREDENTIAL"
  | "POLICY_DENIED"
  | "NO_HEADER_TEMPLATE"
  | "SECRET_UNAVAILABLE"
  | "COMPOSE_FAILED";

export class AuthedFetchError extends Error {
  readonly code: AuthedFetchErrorCode;

  constructor(code: AuthedFetchErrorCode, message: string) {
    super(message);
    this.name = "AuthedFetchError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Server-side use mirrors CredentialBroker.serverUseById: capability must
 * allow authedFetch, and domain-scoped (browser) credentials are rejected.
 */
function assertCredentialUsableForAuthedFetch(
  resolved: ResolvedCredential,
): void {
  if (!isToolAllowed(AUTHED_FETCH_CAPABILITY, resolved.metadata.allowedTools)) {
    const tools = resolved.metadata.allowedTools ?? [];
    throw new AuthedFetchError(
      "POLICY_DENIED",
      `Credential ${resolved.service}/${resolved.field} does not allow "${AUTHED_FETCH_CAPABILITY}".` +
        (tools.length === 0
          ? " No tools are currently allowed — update allowed_tools via `assistant credentials set`."
          : ` Allowed tools: ${tools.join(", ")}.`),
    );
  }

  const domains = resolved.metadata.allowedDomains ?? [];
  if (domains.length > 0) {
    throw new AuthedFetchError(
      "POLICY_DENIED",
      `Credential ${resolved.service}/${resolved.field} has domain restrictions ` +
        `(${domains.join(", ")}) and cannot be used server-side. ` +
        "Remove domain restrictions or use a separate credential without domain policy.",
    );
  }
}

function isMetadataUsableForAuthedFetch(meta: {
  allowedTools?: string[];
  allowedDomains?: string[];
}): boolean {
  if (!isToolAllowed(AUTHED_FETCH_CAPABILITY, meta.allowedTools ?? [])) {
    return false;
  }
  return (meta.allowedDomains ?? []).length === 0;
}

function resolveRequestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) {
    return input;
  }
  if (typeof input === "string") {
    return new URL(input);
  }
  // Request object — prefer its URL; `init` cannot override Request.url.
  return new URL(input.url);
}

function collectTemplates(credentialPin?: string): {
  credentialIds: string[];
  templates: Map<string, CredentialInjectionTemplate[]>;
} {
  const templates = new Map<string, CredentialInjectionTemplate[]>();
  const credentialIds: string[] = [];

  if (credentialPin !== undefined) {
    const resolved = resolveCredentialRef(credentialPin);
    if (!resolved) {
      throw new AuthedFetchError(
        "NO_CREDENTIAL",
        `Unknown credential reference "${credentialPin}". Use \`assistant credentials list\` to see available credentials.`,
      );
    }
    if (resolved.injectionTemplates.length === 0) {
      throw new AuthedFetchError(
        "NO_HEADER_TEMPLATE",
        `Credential ${resolved.service}/${resolved.field} has no injection templates.`,
      );
    }
    const hasHeader = resolved.injectionTemplates.some(
      (template) => template.injectionType === "header" && template.headerName,
    );
    if (!hasHeader) {
      throw new AuthedFetchError(
        "NO_HEADER_TEMPLATE",
        `Credential ${resolved.service}/${resolved.field} has no header injection template (query injection is not supported by authedFetch).`,
      );
    }
    credentialIds.push(resolved.credentialId);
    templates.set(resolved.credentialId, resolved.injectionTemplates);
    return { credentialIds, templates };
  }

  for (const meta of listCredentialMetadata()) {
    const tpls = meta.injectionTemplates ?? [];
    if (tpls.length === 0) {
      continue;
    }
    // Exclude credentials that cannot authorize this path so they cannot
    // shadow a usable match (ambiguous / policy-denied on a bad candidate).
    if (!isMetadataUsableForAuthedFetch(meta)) {
      continue;
    }
    credentialIds.push(meta.credentialId);
    templates.set(meta.credentialId, tpls);
  }

  return { credentialIds, templates };
}

function mergeHeaders(
  existing: HeadersInit | undefined,
  headerName: string,
  headerValue: string,
): Headers {
  const headers = new Headers(existing);
  headers.set(headerName, headerValue);
  return headers;
}

/**
 * Fetch with credential header injection.
 *
 * Injected header values overwrite a caller-provided header of the same name
 * (matches script-proxy MITM rewrite behavior).
 */
export async function authedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: AuthedFetchOptions,
): Promise<Response> {
  let url: URL;
  try {
    url = resolveRequestUrl(input);
  } catch {
    throw new AuthedFetchError(
      "MISSING_URL",
      "authedFetch requires a valid absolute URL",
    );
  }

  const hostname = url.hostname;
  if (!hostname) {
    throw new AuthedFetchError(
      "MISSING_URL",
      "authedFetch requires a URL with a hostname",
    );
  }

  const { credentialIds, templates } = collectTemplates(options?.credential);

  const decision = evaluateRequest(
    hostname,
    url.pathname || "/",
    credentialIds,
    templates,
  );

  if (decision.kind === "ambiguous") {
    const labels = decision.candidates
      .map((candidate) => {
        const resolved = resolveById(candidate.credentialId);
        const name = resolved
          ? `${resolved.service}/${resolved.field}`
          : candidate.credentialId;
        return `${name} (${candidate.template.hostPattern})`;
      })
      .join(", ");
    throw new AuthedFetchError(
      "AMBIGUOUS_CREDENTIAL",
      `Multiple credentials match host "${hostname}": ${labels}. Pass options.credential to disambiguate.`,
    );
  }

  if (decision.kind !== "matched") {
    throw new AuthedFetchError(
      "NO_CREDENTIAL",
      `No credential with a header injection template matches host "${hostname}".` +
        (options?.credential
          ? ` Pinned credential "${options.credential}" did not match.`
          : " Add injection templates or pass options.credential."),
    );
  }

  const { credentialId, template } = decision;

  if (template.injectionType !== "header" || !template.headerName) {
    throw new AuthedFetchError(
      "NO_HEADER_TEMPLATE",
      `Matched credential for host "${hostname}" has no header injection template (query injection is not supported by authedFetch).`,
    );
  }

  const resolved = resolveById(credentialId);
  if (!resolved) {
    throw new AuthedFetchError(
      "NO_CREDENTIAL",
      `Credential ${credentialId} could not be resolved after match`,
    );
  }

  assertCredentialUsableForAuthedFetch(resolved);

  const secret = await getSecureKeyAsync(resolved.storageKey);
  if (!secret) {
    throw new AuthedFetchError(
      "SECRET_UNAVAILABLE",
      `Credential metadata exists but no stored value for ${resolved.service}/${resolved.field}`,
    );
  }

  const headerValue = await buildInjectedValue(template, secret);
  if (!headerValue) {
    throw new AuthedFetchError(
      "COMPOSE_FAILED",
      `Failed to compose injected value for ${resolved.service}/${resolved.field} (composeWith credential missing)`,
    );
  }

  const callerHeaders =
    init?.headers ??
    (typeof input !== "string" && !(input instanceof URL) && "headers" in input
      ? input.headers
      : undefined);

  const headers = mergeHeaders(callerHeaders, template.headerName, headerValue);

  log.info(
    {
      hostname,
      credentialId,
      service: resolved.service,
      field: resolved.field,
      headerName: template.headerName,
      method: init?.method ?? "GET",
    },
    "Starting authedFetch",
  );

  const response = await fetch(input, {
    ...init,
    headers,
  });

  log.info(
    {
      hostname,
      credentialId,
      status: response.status,
    },
    "Completed authedFetch",
  );

  return response;
}
