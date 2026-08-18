/**
 * Shared scaffolding for hand-rolled HTTP route handlers (the pairing family):
 * the 405 method guard and the read-body-then-extract-one-string-field flow,
 * so each route doesn't re-implement them with drifting error shapes.
 */

import { errorResponse } from "./loopback-guard.js";
import { readLimitedBody } from "./read-limited-body.js";

/** 405 response naming the allowed method. */
export function methodNotAllowed(allow: string): Response {
  return new Response("method not allowed", {
    status: 405,
    headers: { Allow: allow },
  });
}

/**
 * Read a JSON request body under a byte cap and extract one required string
 * field. Returns the raw (untrimmed) field value, or the error `Response` to
 * send: 413 for an oversized body, 400 for an unreadable body, invalid JSON,
 * or a missing/blank field.
 */
export async function readJsonStringField(
  req: Request,
  maxBytes: number,
  field: string,
): Promise<string | Response> {
  const rawBody = await readLimitedBody(req, maxBytes);
  if (rawBody.status === "too_large") {
    return errorResponse("PAYLOAD_TOO_LARGE", "request body too large", 413);
  }
  if (rawBody.status === "unreadable") {
    return errorResponse("BAD_REQUEST", "failed to read request body", 400);
  }

  let value: string | null = null;
  try {
    const body = JSON.parse(rawBody.text) as Record<string, unknown>;
    const raw = body[field];
    value = typeof raw === "string" && raw.trim() ? raw : null;
  } catch {
    return errorResponse("BAD_REQUEST", "invalid JSON body", 400);
  }

  return value ?? errorResponse("BAD_REQUEST", `${field} is required`, 400);
}
