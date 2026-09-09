/**
 * Pure helpers for the OAuth passthrough proxy route
 * (`/v1/oauth/proxy/:provider/:path*`).
 *
 * No DB, no network, no logging: the route and the grant command both build on
 * these, and keeping them side-effect free keeps the wire semantics (path
 * fidelity, header stripping, error mapping) testable in isolation.
 */

import {
  isBinaryOAuthBody,
  type OAuthConnectionResponse,
} from "../../oauth/connection.js";
import {
  CredentialRequiredError,
  InsufficientBalanceError,
  ProviderUnreachableError,
} from "../../oauth/platform-connection.js";
import {
  BadGatewayError,
  BadRequestError,
  ConflictError,
  FailedDependencyError,
  PaymentRequiredError,
  RouteError,
} from "./errors.js";
import { RouteResponse } from "./types.js";

/** Route pattern registered for every proxied HTTP method. */
export const PROXY_ROUTE_ENDPOINT = "oauth/proxy/:provider/:path*";

/** Everything after this prefix is the provider segment plus the upstream path. */
export const PROXY_PATH_PREFIX = "/v1/oauth/proxy/";

/**
 * Number of leading `/`-separated pieces before the upstream path: the empty
 * piece before the leading slash, then `v1`, `oauth`, `proxy`, and the
 * provider segment.
 */
const PROXY_PATH_SEGMENT_COUNT = 5;

/** Request headers that must never reach the provider. */
const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "proxy-authenticate",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "expect",
  "accept-encoding",
  "cookie",
  "forwarded",
  "x-real-ip",
]);

const TEXT_ENCODER = new TextEncoder();

/** Response headers describing a framing this daemon re-does itself. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "trailer",
  "upgrade",
]);

/**
 * Provider segment for a base URL. An account pins one connection when the
 * provider has several.
 */
export function encodeProxyProviderSegment(
  provider: string,
  account?: string,
): string {
  return account ? `${provider}@${encodeURIComponent(account)}` : provider;
}

/**
 * Inverse of {@link encodeProxyProviderSegment}. The router has already
 * percent-decoded the segment, so an account containing `@` still parses:
 * the split is at the first `@`.
 */
export function parseProxyProviderSegment(segment: string): {
  provider: string;
  account?: string;
} {
  const at = segment.indexOf("@");
  const provider = at === -1 ? segment : segment.slice(0, at);
  const account = at === -1 ? "" : segment.slice(at + 1);

  if (!provider || provider.includes("/")) {
    throw new BadRequestError(
      `Invalid OAuth proxy provider segment: "${segment}"`,
    );
  }

  return account ? { provider, account } : { provider };
}

/**
 * Subject a proxy grant is minted with, and the value the route requires in
 * `x-vellum-subject`, so a grant for one provider cannot reach another.
 */
export function proxyGrantSubject(provider: string): string {
  return `local:self:oauth-proxy.${provider}`;
}

/**
 * Upstream path as the caller wrote it, taken from the raw pathname so
 * percent-encoding survives. Null when the provider segment is the whole path.
 */
export function extractProxyRemainder(rawUrl: URL): string | null {
  const remainder = rawUrl.pathname
    .split("/")
    .slice(PROXY_PATH_SEGMENT_COUNT)
    .join("/");
  return remainder === "" ? null : remainder;
}

/**
 * Resolve `.` and `..` and reject anything that could retarget the request
 * (an absolute URL, `//host`, an empty segment). Segments are never decoded or
 * re-encoded, so `%2F` reaches the provider as the caller wrote it.
 */
export function normalizeProxyPath(remainder: string): string {
  const segments = remainder.split("/");
  const trailingSlash = segments.length > 1 && segments.at(-1) === "";
  if (trailingSlash) {
    segments.pop();
  }

  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "") {
      throw new BadRequestError(
        "Absolute URLs and empty path segments are not allowed",
      );
    }
    if (segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (resolved.length === 0) {
        throw new BadRequestError(
          "The proxied path may not climb above the provider API base",
        );
      }
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  const path = `/${resolved.join("/")}`;
  return trailingSlash && !path.endsWith("/") ? `${path}/` : path;
}

/**
 * Decoded query parameters, repeated keys collapsed into arrays in wire order.
 * Both connection classes re-encode these.
 */
export function parseProxyQuery(
  search: string,
): Record<string, string | string[]> | undefined {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(search)) {
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      query[key] = [existing, value];
    }
  }
  return Object.keys(query).length > 0 ? query : undefined;
}

/**
 * Caller headers minus the daemon's own credential, hop-by-hop framing, and
 * anything the edge injected. Content type, accept, user agent, and custom
 * `x-*` headers pass through untouched.
 */
export function sanitizeInboundHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const stripped = new Set(STRIPPED_REQUEST_HEADERS);
  for (const token of findHeader(headers, "connection")?.split(",") ?? []) {
    const listed = token.trim().toLowerCase();
    if (listed) {
      stripped.add(listed);
    }
  }

  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      stripped.has(lower) ||
      lower.startsWith("x-forwarded-") ||
      lower.startsWith("x-vellum-")
    ) {
      continue;
    }
    sanitized[name] = value;
  }
  return sanitized;
}

/**
 * Turn a connection response into the bytes and headers the caller sees. The
 * provider's status is preserved; framing headers are dropped because this
 * response is re-framed on the way out.
 */
export function materializeProxyResponse(
  upstream: OAuthConnectionResponse,
  method: string,
): RouteResponse {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(upstream.headers ?? {})) {
    if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }

  const bodyless =
    method.toUpperCase() === "HEAD" ||
    upstream.status === 204 ||
    upstream.status === 304;
  if (bodyless) {
    return new RouteResponse(null, headers, upstream.status);
  }

  const body = upstream.body;
  let bytes: BodyInit | null;
  if (isBinaryOAuthBody(body)) {
    // Re-wrapped because `BodyInit` rejects a `Uint8Array<ArrayBufferLike>`.
    bytes = new Uint8Array(body);
  } else if (typeof body === "string") {
    bytes = TEXT_ENCODER.encode(body);
  } else if (body === null || body === undefined) {
    bytes = null;
  } else {
    bytes = TEXT_ENCODER.encode(JSON.stringify(body));
    if (findHeader(headers, "content-type") === undefined) {
      headers["content-type"] = "application/json";
    }
  }

  return new RouteResponse(bytes, headers, upstream.status);
}

/**
 * The resolver throws plain `Error`s for "no active connection", "missing
 * prerequisites", and "missing scopes". All of them mean the caller's
 * dependency is unavailable until they reconnect.
 */
export function mapProxyResolveError(
  err: unknown,
  provider: string,
): RouteError {
  if (err instanceof RouteError) {
    return err;
  }
  return new FailedDependencyError(
    errorMessage(err),
    reconnectDetails(provider),
  );
}

/** Map a connection-layer failure onto the status the caller should see. */
export function mapProxyRequestError(
  err: unknown,
  provider: string,
): RouteError {
  if (err instanceof CredentialRequiredError) {
    return new FailedDependencyError(err.message, reconnectDetails(provider));
  }
  if (err instanceof InsufficientBalanceError) {
    return new PaymentRequiredError(err.message);
  }
  if (err instanceof ProviderUnreachableError) {
    return new BadGatewayError(err.message);
  }
  if (err instanceof RouteError) {
    return err;
  }
  return new BadGatewayError(errorMessage(err));
}

/**
 * Several connections match the provider and the caller pinned none. The CLI
 * prints only the message, so it names the accounts and how to pick one.
 */
export function ambiguousConnectionError(
  provider: string,
  accounts: string[],
): ConflictError {
  const providerSegments = accounts.map((account) =>
    encodeProxyProviderSegment(provider, account),
  );
  const example = providerSegments[0] ?? provider;
  return new ConflictError(
    `Multiple ${provider} connections are available (${accounts.join(", ")}). ` +
      `Pin one by putting its account in the provider segment of the base URL, for example "${example}".`,
    { provider, accounts, providerSegments },
  );
}

function reconnectDetails(provider: string): {
  provider: string;
  reconnect: string;
} {
  return { provider, reconnect: `assistant oauth connect ${provider}` };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Case-insensitive lookup, since inbound header casing is the caller's. */
function findHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  return Object.entries(headers).find(
    ([header]) => header.toLowerCase() === target,
  )?.[1];
}
