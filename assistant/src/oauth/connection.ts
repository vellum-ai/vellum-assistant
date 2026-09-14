export interface OAuthConnectionRequest {
  method: string;
  path: string; // relative, e.g. "/2/tweets"
  query?: Record<string, string | string[]>;
  /**
   * Query string appended to the URL verbatim, leading `?` optional and the
   * text already wire-encoded. For callers forwarding a query a provider signs,
   * where rebuilding {@link OAuthConnectionRequest.query} would reorder
   * interleaved repeated keys, rewrite `%20` as `+`, and give a valueless flag
   * an `=`. An empty one falls through to `query`. Honored by BYO connections;
   * a managed connection sends `query` to the platform proxy, which rebuilds
   * it.
   */
  rawQuery?: string;
  headers?: Record<string, string>;
  /**
   * A string is forwarded to the provider verbatim under the caller's own
   * `Content-Type` (multipart, XML, form-encoded). A Buffer or Uint8Array
   * is forwarded as raw bytes. Anything else is JSON-serialized and sent
   * as `application/json`.
   */
  body?: unknown;
  /**
   * Override the connection's default base URL for this request.
   * Required for providers that span multiple API hosts sharing
   * one OAuth token (e.g. Google: Gmail, Calendar, People all
   * use the same credential but different base URLs).
   */
  baseUrl?: string;
  /** Optional abort signal to cancel the request. */
  signal?: AbortSignal;
  /**
   * When true the connection returns the response body as raw bytes with no
   * JSON parsing, for callers that must preserve the provider's exact payload.
   * Mirrors `RouteDefinition.rawRequestBody` on the inbound side.
   */
  rawResponseBody?: boolean;
  /**
   * When true the connection returns a 3xx response as-is, `Location` header
   * intact, rather than following it. For callers that must surface the
   * provider's own redirect instead of an upstream hop the caller never made.
   */
  manualRedirect?: boolean;
  /**
   * When true the connection makes exactly one upstream attempt and surfaces a
   * retryable status to the caller instead of replaying the request. For
   * callers forwarding writes they cannot safely repeat. Governs status-driven
   * retries only: a BYO connection's refresh-and-retry follows a provider 401,
   * which rejected the request before it took effect.
   */
  singleAttempt?: boolean;
}

/** Methods HTTP defines as idempotent, so replaying one is safe. */
const IDEMPOTENT_METHODS = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
  "PUT",
  "DELETE",
  "TRACE",
]);

/**
 * Whether repeating this method is safe by HTTP semantics. Callers forwarding
 * arbitrary traffic pair this with `singleAttempt` so POST and PATCH are never
 * replayed on their behalf.
 */
export function isIdempotentHttpMethod(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

export interface OAuthConnectionResponse {
  status: number;
  headers: Record<string, string>;
  /** JSON, UTF-8 text, or a Buffer of raw bytes for binary payloads. */
  body: unknown;
}

const TEXT_MEDIA_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "text/xml",
  "application/javascript",
  "application/x-www-form-urlencoded",
  "application/problem+json",
  "application/xhtml+xml",
  "application/graphql",
  "application/graphql+json",
]);

function mediaTypeOf(contentType: string): string {
  return contentType.split(";", 1)[0].trim().toLowerCase();
}

function isTextMediaType(mediaType: string): boolean {
  if (!mediaType) {
    return false;
  }
  if (mediaType.startsWith("text/")) {
    return true;
  }
  if (TEXT_MEDIA_TYPES.has(mediaType)) {
    return true;
  }
  return mediaType.endsWith("+json") || mediaType.endsWith("+xml");
}

/**
 * Decode an HTTP body into JSON, UTF-8 text, or a raw Buffer.
 *
 * Binary payloads (Google Drive `?alt=media`, images, PDFs) stay as bytes.
 * JSON and text content types keep their existing parsed/string behavior.
 */
export function decodeOAuthResponseBytes(
  raw: Uint8Array,
  contentType: string,
): unknown {
  if (raw.byteLength === 0) {
    return null;
  }

  const mediaType = mediaTypeOf(contentType);
  let utf8: string | undefined;
  try {
    utf8 = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    utf8 = undefined;
  }

  if (utf8 !== undefined) {
    try {
      return JSON.parse(utf8) as unknown;
    } catch {
      if (!mediaType || isTextMediaType(mediaType)) {
        return utf8;
      }
    }
  }

  if (isTextMediaType(mediaType)) {
    return new TextDecoder("utf-8").decode(raw);
  }

  return Buffer.from(raw);
}

export function isBinaryOAuthBody(body: unknown): body is Uint8Array {
  return body instanceof Uint8Array;
}

/**
 * JSON-safe form of an OAuth response body. Binary buffers become a base64
 * string plus `bodyEncoding: "base64"` so CLI/HTTP JSON envelopes can round
 * trip the original bytes.
 */
export function jsonSafeOAuthBody(body: unknown): {
  body: unknown;
  bodyEncoding?: "base64";
} {
  if (isBinaryOAuthBody(body)) {
    return {
      body: Buffer.from(body).toString("base64"),
      bodyEncoding: "base64",
    };
  }
  return { body };
}

/**
 * Inverse of {@link jsonSafeOAuthBody}. Restores a `bodyEncoding: "base64"`
 * envelope to a Buffer so callers can write the original bytes.
 */
export function decodeJsonSafeOAuthBody(envelope: {
  body: unknown;
  bodyEncoding?: string | null;
}): unknown {
  if (envelope.bodyEncoding === "base64") {
    if (typeof envelope.body !== "string") {
      throw new Error(
        "OAuth response marked bodyEncoding=base64 but body is not a string",
      );
    }
    return Buffer.from(envelope.body, "base64");
  }
  return envelope.body;
}

/**
 * Bytes to write for a CLI `oauth request` body. Binary envelopes become
 * raw bytes. Text stays UTF-8. Parsed JSON is pretty-printed. Null bodies
 * produce no output.
 */
export function materializeOAuthRequestOutput(envelope: {
  body: unknown;
  bodyEncoding?: string | null;
}): { bytes: Buffer; isBinary: boolean } | null {
  const decoded = decodeJsonSafeOAuthBody(envelope);
  if (decoded == null) {
    return null;
  }
  if (isBinaryOAuthBody(decoded)) {
    return { bytes: Buffer.from(decoded), isBinary: true };
  }
  if (typeof decoded === "string") {
    return { bytes: Buffer.from(decoded, "utf8"), isBinary: false };
  }
  return {
    bytes: Buffer.from(JSON.stringify(decoded, null, 2), "utf8"),
    isBinary: false,
  };
}

export interface OAuthConnection {
  /** Make an authenticated HTTP request through this connection. */
  request(req: OAuthConnectionRequest): Promise<OAuthConnectionResponse>;

  /**
   * Execute a callback with a valid raw access token. This is an escape hatch
   * for provider-specific endpoints that don't fit the relative-path model
   * (e.g. Gmail batch API on a different host). Throws for platform connections
   * where raw tokens are not available locally.
   */
  withToken<T>(fn: (token: string) => Promise<T>): Promise<T>;

  readonly id: string;
  readonly provider: string;
  readonly accountInfo: string | null;
}
