/**
 * Test helper that bridges old Request-based handler calls to the new
 * RouteHandlerArgs pattern. Allows existing tests to continue passing
 * Request objects while handlers accept RouteHandlerArgs internally.
 */
import { RouteError } from "../../runtime/routes/errors.js";
import type { RouteHandlerArgs } from "../../runtime/routes/types.js";
import { RouteResponse } from "../../runtime/routes/types.js";

export async function callHandler(
  handler: (args: RouteHandlerArgs) => Promise<unknown>,
  req: Request,
  pathParams?: Record<string, string>,
  /** Override the default 200 success status (e.g. 202 for async job routes). */
  successStatus = 200,
): Promise<Response> {
  // Read content-type BEFORE consuming the body — Bun clears headers after arrayBuffer().
  const contentType = req.headers.get("content-type") ?? "";
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let body: Record<string, unknown> | undefined;
  let rawBody: Uint8Array | undefined;

  if (req.method !== "GET" && req.method !== "HEAD") {
    if (contentType.includes("application/json")) {
      try {
        body = (await req.clone().json()) as Record<string, unknown>;
      } catch {
        /* no body or invalid JSON */
      }
    }
    // Always capture rawBody for non-JSON content types
    if (!contentType.includes("application/json") || !body) {
      try {
        rawBody = new Uint8Array(await req.arrayBuffer());
      } catch {
        /* no body */
      }
    }
  }

  const args: RouteHandlerArgs = { body, rawBody, headers, pathParams };

  try {
    const result = await handler(args);
    if (result instanceof RouteResponse) {
      return new Response(result.body, {
        status: result.status ?? successStatus,
        headers: result.headers,
      });
    }
    if (
      result instanceof ReadableStream ||
      result instanceof Uint8Array ||
      typeof result === "string"
    ) {
      return new Response(result as BodyInit, { status: successStatus });
    }
    return Response.json(result, { status: successStatus });
  } catch (err) {
    if (err instanceof RouteError) {
      return Response.json(
        { error: { code: err.code, message: err.message } },
        { status: err.statusCode },
      );
    }
    throw err;
  }
}
