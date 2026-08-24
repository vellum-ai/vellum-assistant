export interface OAuthConnectionRequest {
  method: string;
  path: string; // relative, e.g. "/2/tweets"
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
  /**
   * A string is forwarded to the provider verbatim under the caller's own
   * `Content-Type` (multipart, XML, form-encoded). Anything else is
   * JSON-serialized and sent as `application/json`.
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
