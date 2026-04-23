/**
 * Request/response proxy forwarding helpers shared across gateway
 * control-plane and admin proxy routes.
 *
 * Encapsulates the common pattern of:
 *  1. Buffering the request body
 *  2. Forwarding to the assistant runtime with service-token auth
 *  3. Mapping timeouts to 504 Gateway Timeout
 *  4. Mapping connection failures to 502 Bad Gateway
 *  5. Sanitizing response headers (hop-by-hop stripping)
 */

import {
  buildUpstreamUrl,
  createTimeoutController,
  isTimeoutError,
  prepareUpstreamHeaders,
  stripHopByHop,
} from "./http-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProxyForwardOptions = {
  /** Base URL of the assistant runtime (e.g. `http://localhost:7821`). */
  baseUrl: string;
  /** Path on the upstream server (e.g. `/v1/health`). */
  path: string;
  /** Query string to append, including the leading `?` (e.g. `?foo=bar`). */
  search?: string;
  /** Service token for upstream auth. */
  serviceToken: string;
  /** Timeout in milliseconds for the upstream request. */
  timeoutMs: number;
  /**
   * Custom fetch implementation. Defaults to the global `fetch`. Useful
   * for testing or when the gateway wraps fetch with instrumentation.
   */
  fetchImpl?: typeof fetch;
};

export type ProxyForwardResult = {
  /** The upstream HTTP status code, or the synthetic gateway error code. */
  status: number;
  /** Response headers (hop-by-hop stripped). */
  headers: Headers;
  /**
   * The response body. For error responses (>= 400), this is the consumed
   * text. For successful responses, this is the raw `ReadableStream` (or
   * `null`) so the caller can stream it through.
   */
  body: ReadableStream<Uint8Array> | string | null;
  /** `true` when the response was a synthetic gateway error (502/504). */
  gatewayError: boolean;
};

// ---------------------------------------------------------------------------
// Core proxy forward
// ---------------------------------------------------------------------------

/**
 * Forward an incoming request to the assistant runtime and return the
 * result. This function does **not** construct a `Response` object — the
 * caller is responsible for that so it can add route-specific logging or
 * headers.
 *
 * The request body is buffered (via `arrayBuffer()`) before forwarding to
 * avoid `Content-Length` mismatches when Bun re-sends a `ReadableStream`.
 */
export async function proxyForward(
  req: Request,
  opts: ProxyForwardOptions,
): Promise<ProxyForwardResult> {
  const upstream = buildUpstreamUrl(opts.baseUrl, opts.path, opts.search);

  const reqHeaders = prepareUpstreamHeaders(
    new Headers(req.headers),
    opts.serviceToken,
  );

  // Buffer the body to get an accurate Content-Length
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const bodyBuffer = hasBody ? await req.arrayBuffer() : null;
  if (bodyBuffer !== null) {
    reqHeaders.set("content-length", String(bodyBuffer.byteLength));
  }

  const { controller, clear } = createTimeoutController(opts.timeoutMs);
  const doFetch = opts.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(upstream, {
      method: req.method,
      headers: reqHeaders,
      body: bodyBuffer,
      signal: controller.signal,
    });
    clear();
  } catch (err) {
    clear();
    if (isTimeoutError(err)) {
      return {
        status: 504,
        headers: new Headers({ "content-type": "application/json" }),
        body: JSON.stringify({ error: "Gateway Timeout" }),
        gatewayError: true,
      };
    }
    return {
      status: 502,
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify({ error: "Bad Gateway" }),
      gatewayError: true,
    };
  }

  const resHeaders = stripHopByHop(new Headers(response.headers));

  if (response.status >= 400) {
    const body = await response.text();
    return {
      status: response.status,
      headers: resHeaders,
      body,
      gatewayError: false,
    };
  }

  return {
    status: response.status,
    headers: resHeaders,
    body: response.body,
    gatewayError: false,
  };
}

/**
 * Convenience wrapper that calls `proxyForward` and returns a `Response`.
 * Suitable for routes that do not need custom post-processing.
 */
export async function proxyForwardToResponse(
  req: Request,
  opts: ProxyForwardOptions,
): Promise<Response> {
  const result = await proxyForward(req, opts);
  return new Response(result.body, {
    status: result.status,
    headers: result.headers,
  });
}
