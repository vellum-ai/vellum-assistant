/**
 * Tests for streaming handler results on the HTTP transport.
 *
 * A handler that returns `{ stream, headers }` (an attachment proxied from
 * an upstream service) must reach HTTP clients as the raw bytes plus the
 * handler's headers. `transfer-encoding` is a hop-by-hop header owned by the
 * HTTP server (RFC 9110 §7.6.1, https://httpwg.org/specs/rfc9110.html#field.connection),
 * so it must not be copied onto the Response.
 */

import { describe, expect, test } from "bun:test";

import { routeDefinitionsToHTTPRoutes } from "../http-adapter.js";
import type { RouteDefinition } from "../types.js";

function streamingRoute(body: Uint8Array): RouteDefinition {
  return {
    operationId: "test_stream",
    endpoint: "test/stream",
    method: "GET",
    policy: null,
    handler: () => ({
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
      headers: {
        "content-type": "application/pdf",
        "transfer-encoding": "chunked",
        "x-filename": "caf_.pdf",
        "x-filename-encoded": "caf%C3%A9.pdf",
      },
    }),
  };
}

async function invoke(route: RouteDefinition): Promise<Response> {
  const [httpRoute] = routeDefinitionsToHTTPRoutes([route]);
  const req = new Request("http://daemon.local/v1/test/stream");
  return httpRoute.handler({
    req,
    url: new URL(req.url),
    server: undefined as never,
    // The route has no policy, so the handler never reads the auth context.
    authContext: undefined as never,
    params: {},
  });
}

describe("http-adapter streaming responses", () => {
  test("streams the handler's bytes with its headers", async () => {
    // GIVEN a route whose handler returns a byte stream and headers
    const bytes = new Uint8Array([37, 80, 68, 70]); // %PDF
    const route = streamingRoute(bytes);

    // WHEN the route is invoked over HTTP
    const response = await invoke(route);

    // THEN the body is the streamed bytes, not a JSON serialization
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);

    // AND the handler's headers are on the response
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("x-filename")).toBe("caf_.pdf");
    expect(response.headers.get("x-filename-encoded")).toBe("caf%C3%A9.pdf");

    // AND the hop-by-hop transfer-encoding header is not forwarded
    expect(response.headers.get("transfer-encoding")).toBeNull();
  });
});
