/**
 * Transparent OAuth passthrough proxy (`/v1/oauth/proxy/:provider/:path*`).
 *
 * A stock third-party CLI points its API base here and presents a grant minted
 * by `oauth_proxy_grant`. The route trades that grant for the credential the
 * resolved connection holds, so the CLI never sees a provider token and can
 * reach nothing but that connection's own API base, for the one provider and
 * account the grant's subject names.
 *
 * Wire semantics (path fidelity, header stripping, error mapping) live in
 * `oauth-proxy-passthrough.ts`; this module is the wiring around them.
 */

import { isPlatformAuthBypassActive } from "../../config/env.js";
import {
  isIdempotentHttpMethod,
  type OAuthConnectionResponse,
} from "../../oauth/connection.js";
import type { OAuthConnectionResolution } from "../../oauth/connection-resolver.js";
import { resolveOAuthConnectionWithMeta } from "../../oauth/connection-resolver.js";
import { getProvider } from "../../oauth/oauth-store.js";
import {
  PlatformOAuthConnection,
  prepareManagedProxyHeaders,
} from "../../oauth/platform-connection.js";
import { getLogger } from "../../util/logger.js";
import { LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import {
  BadRequestError,
  ForbiddenError,
  HttpTransportRequiredError,
  MethodNotAllowedError,
  NotFoundError,
} from "./errors.js";
import {
  ambiguousConnectionError,
  extractProxyRemainder,
  mapProxyRequestError,
  mapProxyResolveError,
  materializeProxyResponse,
  normalizeProxyPath,
  parseProxyProviderSegment,
  parseProxyQuery,
  PROXY_ROUTE_ENDPOINT,
  proxyGrantSubject,
  sanitizeInboundHeaders,
} from "./oauth-proxy-passthrough.js";
import type {
  RouteDefinition,
  RouteHandlerArgs,
  RouteResponse,
} from "./types.js";

const log = getLogger("oauth-proxy-routes");

export async function handleOAuthProxy(
  method: string,
  args: RouteHandlerArgs,
): Promise<RouteResponse> {
  // Only the HTTP adapter supplies the wire-exact URL this route forwards. The
  // refusal carries the gateway's retry-over-HTTP signal and precedes every
  // provider call, so the retry reaches upstream exactly once.
  // An IPC caller controls every handler arg, so the guard checks the type
  // rather than truthiness: a plain object carrying pathname and search would
  // otherwise satisfy it and reach a provider with the real credential.
  if (!(args.rawUrl instanceof URL)) {
    throw new HttpTransportRequiredError(
      "The OAuth proxy is served over HTTP only; retry this request over the HTTP transport",
    );
  }

  const { provider, account } = parseProxyProviderSegment(
    args.pathParams?.provider ?? "",
  );

  // A grant names one provider and, when it pinned one, one account. The
  // subject is re-derived from this request's own segment, so rewriting or
  // dropping `@account` cannot match the grant's subject. Only a
  // platform-managed pod skips the comparison: there the daemon discards the
  // token and builds a synthetic context that carries no grant subject to
  // compare against.
  if (
    !isPlatformAuthBypassActive() &&
    args.headers?.["x-vellum-subject"] !== proxyGrantSubject(provider, account)
  ) {
    throw new ForbiddenError(
      "This grant was minted for a different provider or account",
    );
  }

  if (!getProvider(provider)) {
    throw new NotFoundError(
      `Unknown provider "${provider}". Run 'assistant oauth providers list' to see available providers.`,
    );
  }

  const remainder = extractProxyRemainder(args.rawUrl);
  if (remainder === null) {
    throw new BadRequestError(
      "A provider API path is required after the provider segment",
    );
  }
  const path = normalizeProxyPath(remainder);
  const query = parseProxyQuery(args.rawUrl.search);
  let headers = sanitizeInboundHeaders(args.headers ?? {});

  let resolution: OAuthConnectionResolution;
  try {
    resolution = await resolveOAuthConnectionWithMeta(
      provider,
      account ? { account } : undefined,
    );
  } catch (err) {
    throw mapProxyResolveError(err, provider);
  }
  if (resolution.ambiguous) {
    throw ambiguousConnectionError(provider, resolution.allAccounts);
  }

  const { connection } = resolution;
  if (connection instanceof PlatformOAuthConnection) {
    if (method === "HEAD") {
      throw new MethodNotAllowedError(
        "Managed connections do not support HEAD",
      );
    }
    const managedHeaders = prepareManagedProxyHeaders(headers);
    const { unsupportedHeaders } = managedHeaders;
    if (unsupportedHeaders.length > 0) {
      throw new BadRequestError(
        `Managed OAuth connections cannot forward these request headers: ${unsupportedHeaders.join(", ")}. The request was not sent to the provider.`,
      );
    }
    headers = managedHeaders.headers;
  }

  // A Buffer travels as raw bytes on BYO and as base64 on the platform, in
  // both cases under the caller's own Content-Type.
  const body =
    carriesBody(method) && args.rawBody?.byteLength
      ? Buffer.from(args.rawBody)
      : undefined;

  let upstream: OAuthConnectionResponse;
  try {
    // No `baseUrl`: the connection's own base is the only host ever targeted,
    // and the caller controls the path and query alone.
    upstream = await connection.request({
      method,
      path,
      query,
      headers,
      body,
      signal: args.abortSignal,
      // Byte-exact passthrough. Honored by BYO connections; a managed
      // connection is parsed platform-side and cannot offer it.
      rawResponseBody: true,
      // The caller's own HTTP client decides what to do with a 3xx; the
      // proxy never makes an upstream hop on its behalf.
      manualRedirect: true,
      // A retryable status can arrive after the provider has already been
      // called, so a write the caller cannot repeat is never replayed. GET and
      // the other idempotent methods keep their retries.
      singleAttempt: !isIdempotentHttpMethod(method),
      // The provider signing this query sees the bytes the caller wrote: key
      // order, `%20`, and valueless flags all survive. Managed connections
      // have no raw mode and send `query` instead.
      rawQuery: args.rawUrl.search,
    });
  } catch (err) {
    // The grant holder is told only which dependency failed, so the provider's
    // own text lives here. Neither the grant nor the credential is in it.
    log.warn({ provider, method, path, err }, "OAuth proxy request failed");
    throw mapProxyRequestError(err, provider);
  }

  log.debug(
    { provider, method, path, status: upstream.status },
    "OAuth proxy request forwarded",
  );

  return materializeProxyResponse(upstream, method);
}

/**
 * Methods the proxy forwards. OPTIONS is absent: a CORS preflight has no
 * meaning for a CLI calling a loopback daemon.
 */
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

/** GET and HEAD carry no request body. */
function carriesBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

/** Opaque bytes in both directions: the proxy never inspects the payload. */
const BINARY_BODY = {
  contentType: "application/octet-stream",
  schema: { type: "string", format: "binary" },
} as const;

const ERROR_RESPONSES: Record<string, { description: string }> = {
  "400": {
    description:
      "Malformed provider segment or proxied path, or request headers unsupported by a managed connection",
  },
  "402": { description: "The managed account is out of balance" },
  "403": {
    description: "The grant was minted for a different provider or account",
  },
  "404": { description: "Unknown provider" },
  "405": { description: "The resolved connection rejects this method" },
  "409": { description: "Several accounts are connected and none was pinned" },
  "421": { description: "Dispatched over IPC; retry over HTTP" },
  "424": { description: "No usable connection; reconnect the provider" },
  "502": { description: "The provider API could not be reached" },
};

export const ROUTES: RouteDefinition[] = METHODS.map((method) => ({
  operationId: `oauth_proxy_${method.toLowerCase()}`,
  endpoint: PROXY_ROUTE_ENDPOINT,
  method,
  policy: {
    requiredScopes: ["oauth.proxy"],
    allowedPrincipalTypes: LOCAL_PRINCIPALS,
  },
  rawRequestBody: true,
  summary: `Proxy a ${method} request through an OAuth connection`,
  description:
    "Forwards the remainder path, query, headers, and body to the provider's API base through the connection resolved from the provider segment; the grant minted by oauth_proxy_grant is the only credential accepted, and it is honored only for the provider and account its subject names.",
  tags: ["oauth"],
  // No `requestBody`: the spec generator marks every declared body required,
  // and a proxied POST, PUT, PATCH, or DELETE may carry none.
  responseBody: BINARY_BODY,
  additionalResponses: ERROR_RESPONSES,
  handler: (args: RouteHandlerArgs) => handleOAuthProxy(method, args),
}));
