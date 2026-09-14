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
} from "../../oauth/platform-connection.js";
import type { TokenExpiredError } from "../../security/token-manager.js";
import { findContentTypeHeader } from "../../util/oauth-request-body.js";
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
 * Leading `/`-separated pieces before the upstream path. Splitting the prefix
 * yields the empty piece before its leading slash, `v1`, `oauth`, `proxy`, and
 * a trailing empty piece: the slot the provider segment fills.
 */
const PROXY_PATH_SEGMENT_COUNT = PROXY_PATH_PREFIX.split("/").length;

/** Request headers that must never reach the provider. */
const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
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
  // The gateway stamps this on every request it forwards. It names this
  // hop's trace, not the caller's request, and the daemon never reads it.
  "x-trace-id",
]);

const TEXT_ENCODER = new TextEncoder();

/**
 * Statuses the `Response` constructor refuses a body on, limited to the ones
 * this route can emit. The interim 1xx statuses are absent: a BYO `fetch`
 * never surfaces one as a final response and the platform envelope refuses a
 * status outside 200 to 599, so a `RouteResponse` carrying one would only make
 * the adapter's `Response` constructor throw.
 */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** Metadata about the entity, as opposed to framing of this hop. */
const ENTITY_METADATA_HEADERS = ["content-length", "content-encoding"];

/**
 * Response headers the caller never sees on a body-carrying response: framing
 * this daemon re-does itself, and a cookie the request side already refuses to
 * send back, which would only plant provider state on the daemon's own origin.
 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  ...ENTITY_METADATA_HEADERS,
  "transfer-encoding",
  "connection",
  "keep-alive",
  "trailer",
  "upgrade",
  "set-cookie",
  "set-cookie2",
]);

/**
 * The same, minus the entity metadata a HEAD is made to read. Only a HEAD
 * keeps it: Bun forwards `content-length` verbatim there, and writes its own
 * `Content-Length: 0` over whatever a 204, 205, or 304 carries, so a
 * forwarded value would sit in the `RouteResponse` and never reach the wire.
 * RFC 7230 section 3.3.2 forbids the header on a 204 in any case.
 */
const STRIPPED_HEAD_RESPONSE_HEADERS = new Set(
  [...STRIPPED_RESPONSE_HEADERS].filter(
    (name) => !ENTITY_METADATA_HEADERS.includes(name),
  ),
);

/**
 * Header a provider's 3xx target is moved onto.
 *
 * A grant is a live credential for this daemon, and a client that keeps
 * `Authorization` across hosts (`curl --location-trusted`, a hand-rolled
 * redirect loop) would hand it to the provider on the very first hop. Under
 * a name no HTTP client follows, the target stays readable and is not
 * reachable by accident. The 3xx status itself is preserved.
 */
export const PROXY_LOCATION_HEADER = "x-vellum-proxy-location";

/**
 * Provider segment for a base URL. An account pins one connection when the
 * provider has several; an empty label pins nothing, leaving the bare provider
 * key as the segment and an unpinned subject to match.
 *
 * Keys stay literal in both the URL segment and {@link proxyGrantSubject}, so
 * only URL-unreserved characters are allowed and dot segments are refused.
 */
export function encodeProxyProviderSegment(
  provider: string,
  account?: string,
): string {
  assertProxyProviderKey(provider);
  return account ? `${provider}@${encodeAccount(account)}` : provider;
}

function assertProxyProviderKey(provider: string): void {
  if (
    !provider ||
    provider === "." ||
    provider === ".." ||
    /[^A-Za-z0-9._~-]/.test(provider)
  ) {
    throw new BadRequestError(
      `Invalid OAuth proxy provider key "${provider}": use letters, digits, "-", "_", ".", or "~", excluding "." and "..".`,
    );
  }
}

/**
 * Percent-encode an account for the segment, and with it for the subject the
 * segment is embedded in: encoding is what keeps a `:` in an account from
 * ending the subject component early, and a control character out of the
 * `x-vellum-subject` header. Its output alphabet holds none of those, so the
 * only text refused here is text `encodeURIComponent` itself rejects, such as
 * a lone surrogate.
 */
function encodeAccount(account: string): string {
  try {
    return encodeURIComponent(account);
  } catch {
    throw new BadRequestError(
      `An OAuth proxy account must be encodable text: "${account}"`,
    );
  }
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

  assertProxyProviderKey(provider);

  return account ? { provider, account } : { provider };
}

/**
 * Subject a proxy grant is minted with, and the value the route requires in
 * `x-vellum-subject`, so a grant for one provider cannot reach another, nor a
 * grant pinned to one account reach a second account of the same provider.
 *
 * The segment builder is reused so the subject and the URL segment cannot
 * drift: the route re-derives this from the account in the request path, and a
 * rewritten `@account` therefore stops matching. An unpinned grant keeps the
 * bare `local:self:oauth-proxy.<provider>` shape.
 */
export function proxyGrantSubject(provider: string, account?: string): string {
  return `local:self:oauth-proxy.${encodeProxyProviderSegment(provider, account)}`;
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
 *
 * The record has a null prototype so a caller's `__proto__`, `constructor`, or
 * `toString` parameter is a plain key rather than an inherited value.
 */
export function parseProxyQuery(
  search: string,
): Record<string, string | string[]> | undefined {
  const query: Record<string, string | string[]> = Object.create(
    null,
  ) as Record<string, string | string[]>;
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
  for (const token of findConnectionHeader(headers)?.split(",") ?? []) {
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
 * provider's status is preserved; framing headers are dropped because a
 * body-carrying response is re-framed on the way out, while a HEAD keeps the
 * entity metadata it exists to convey.
 */
export function materializeProxyResponse(
  upstream: OAuthConnectionResponse,
  method: string,
): RouteResponse {
  const head = method.toUpperCase() === "HEAD";
  const bodyless = head || NULL_BODY_STATUSES.has(upstream.status);
  const stripped = head
    ? STRIPPED_HEAD_RESPONSE_HEADERS
    : STRIPPED_RESPONSE_HEADERS;

  const headers: Record<string, string> = {};
  const redirect = upstream.status >= 300 && upstream.status < 400;
  let location: string | undefined;
  for (const [name, value] of Object.entries(upstream.headers ?? {})) {
    const lower = name.toLowerCase();
    // `x-vellum-*` is this daemon's namespace on both sides of the hop, so a
    // provider cannot author one.
    if (stripped.has(lower) || lower.startsWith("x-vellum-")) {
      continue;
    }
    if (lower === "location" && redirect) {
      location = value;
      continue;
    }
    headers[name] = value;
  }
  if (location !== undefined) {
    headers[PROXY_LOCATION_HEADER] = location;
  }

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
    if (findContentTypeHeader(headers) === undefined) {
      headers["content-type"] = "application/json";
    }
  }

  return new RouteResponse(bytes, headers, upstream.status);
}

/**
 * Who reads a proxy error body.
 *
 * `grant-holder` is the third-party binary the grant was handed to. It learns
 * the provider it already knows and the command that repairs the failure, and
 * never which other accounts of that provider the user holds: account labels
 * are typically email addresses.
 *
 * `operator` is the local principal minting a grant, whose own accounts these
 * are and who needs them named to pick one.
 */
export type ProxyErrorAudience = "grant-holder" | "operator";

/**
 * The resolver throws plain `Error`s for "no active connection", "missing
 * prerequisites", and "missing scopes". All of them mean the caller's
 * dependency is unavailable until they reconnect.
 *
 * Its message enumerates the provider's other active account labels whenever
 * an account filter matched nothing, which a pinned grant reaches by having
 * its connection deleted or relabeled mid-TTL, so only the operator is given
 * it verbatim.
 */
export function mapProxyResolveError(
  err: unknown,
  provider: string,
  audience: ProxyErrorAudience = "grant-holder",
): RouteError {
  if (err instanceof RouteError) {
    return err;
  }
  return new FailedDependencyError(
    audienceMessage(
      audience,
      err,
      `No usable ${provider} connection is available.`,
    ),
    reconnectDetails(provider),
  );
}

/**
 * Map a connection-layer failure onto the status the caller should see.
 *
 * Upstream text arrives here verbatim: a BYO refresh failure carries the
 * provider token endpoint's own response and the refresh breaker's state, and
 * a managed provider that could not be reached carries the platform proxy's
 * body. The grant holder learns which dependency failed and what repairs it,
 * and nothing the provider or the platform wrote; the route logs the verbatim
 * text so the operator still has it.
 *
 * `InsufficientBalanceError` is the exception: it is raised on a bare status
 * with a fixed message about this install's own balance, so both audiences
 * read it.
 */
export function mapProxyRequestError(
  err: unknown,
  provider: string,
  audience: ProxyErrorAudience = "grant-holder",
): RouteError {
  if (err instanceof CredentialRequiredError || isBYOCredentialFailure(err)) {
    return new FailedDependencyError(
      audienceMessage(
        audience,
        err,
        `The ${provider} credential is no longer usable.`,
      ),
      reconnectDetails(provider),
    );
  }
  if (err instanceof InsufficientBalanceError) {
    return new PaymentRequiredError(err.message);
  }
  if (err instanceof RouteError) {
    return err;
  }
  // Everything left is an upstream failure, `ProviderUnreachableError` and a
  // platform envelope this daemon could not parse alike.
  return new BadGatewayError(
    audienceMessage(audience, err, `The ${provider} API could not be reached.`),
  );
}

/**
 * Several connections match the provider and the caller pinned none.
 *
 * For the operator this is the mint refusing to guess, so the CLI, which
 * prints only the message, gets the accounts named and an example segment.
 * Account labels are free text a provider chose, so some of them pin nothing
 * (an empty label) or cannot be encoded at all. Every account is still named:
 * building this error may not throw, or the caller would see an encoding
 * failure in place of the 409.
 *
 * For the grant holder it is a race: a second connection appeared inside the
 * TTL of a grant that pins none. Rewriting the base URL to name an account is
 * not open to it, because the subject an unpinned grant carries matches only
 * the bare provider segment, so the accounts are neither named nor useful.
 */
export function ambiguousConnectionError(
  provider: string,
  accounts: string[],
  audience: ProxyErrorAudience = "grant-holder",
): ConflictError {
  if (audience !== "operator") {
    return new ConflictError(
      `Multiple ${provider} connections are available and this grant pins none. ` +
        `Mint one for a single account with "assistant oauth proxy-url ${provider} --account <account>".`,
      { provider },
    );
  }

  const providerSegments = accounts
    .map((account) => pinningProviderSegment(provider, account))
    .filter((segment): segment is string => segment !== null);
  const example = providerSegments[0];
  const pin =
    "Pin one by putting its account in the provider segment of the base URL";
  return new ConflictError(
    `Multiple ${provider} connections are available (${accounts.join(", ")}). ` +
      (example ? `${pin}, for example "${example}".` : `${pin}.`),
    { provider, accounts, providerSegments },
  );
}

/** Segment pinning one account, or null when the label cannot pin one. */
function pinningProviderSegment(
  provider: string,
  account: string,
): string | null {
  if (!account) {
    return null;
  }
  try {
    return encodeProxyProviderSegment(provider, account);
  } catch {
    return null;
  }
}

/**
 * A BYO connection reports a dead credential either as `TokenExpiredError`
 * (no token, or a refresh that cannot succeed) or, when a refreshed request
 * still comes back 401, as an error carrying `status: 401`. Both mean the same
 * thing the platform's `CredentialRequiredError` does: reconnect.
 */
function isBYOCredentialFailure(err: unknown): boolean {
  return isTokenExpiredError(err) || hasUnauthorizedStatus(err);
}

/**
 * Matched by name rather than `instanceof`: importing the class would pull the
 * token manager's DB and secure-key graph into this side-effect-free module.
 */
function isTokenExpiredError(err: unknown): err is TokenExpiredError {
  return err instanceof Error && err.name === "TokenExpiredError";
}

function hasUnauthorizedStatus(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: unknown }).status === 401
  );
}

function reconnectDetails(provider: string): {
  provider: string;
  reconnect: string;
} {
  return { provider, reconnect: `assistant oauth connect ${provider}` };
}

/** The upstream text for an operator, the fixed line for a grant holder. */
function audienceMessage(
  audience: ProxyErrorAudience,
  err: unknown,
  redacted: string,
): string {
  return audience === "operator" ? errorMessage(err) : redacted;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Case-insensitive lookup, since inbound header casing is the caller's. */
function findConnectionHeader(
  headers: Record<string, string>,
): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "connection") {
      return value;
    }
  }
  return undefined;
}
