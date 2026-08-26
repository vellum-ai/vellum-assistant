/**
 * Shared scaffolding for hand-rolled HTTP route handlers (the pairing family):
 * the 405 method guard and the read-body-then-extract-fields flow, so each
 * route doesn't re-implement them with drifting error shapes.
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
 * Read a JSON request body under a byte cap. Returns the decoded object, or
 * the error `Response` to send: 413 for an oversized body, 400 for an
 * unreadable body, invalid JSON, or a non-object body (null, an array, or a
 * bare primitive).
 */
export async function readJsonObjectBody(
  req: Request,
  maxBytes: number,
): Promise<Record<string, unknown> | Response> {
  const rawBody = await readLimitedBody(req, maxBytes);
  if (rawBody.status === "too_large") {
    return errorResponse("PAYLOAD_TOO_LARGE", "request body too large", 413);
  }
  if (rawBody.status === "unreadable") {
    return errorResponse("BAD_REQUEST", "failed to read request body", 400);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.text);
  } catch {
    return errorResponse("BAD_REQUEST", "invalid JSON body", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return errorResponse("BAD_REQUEST", "invalid JSON body", 400);
  }
  return parsed as Record<string, unknown>;
}

/**
 * One non-blank string field of a decoded JSON body, or null. Returns the raw
 * (untrimmed) value.
 */
export function jsonStringField(
  body: Record<string, unknown>,
  field: string,
): string | null {
  const raw = body[field];
  return typeof raw === "string" && raw.trim() ? raw : null;
}

/**
 * Read a JSON request body under a byte cap and extract one required string
 * field. Returns the raw (untrimmed) field value, or the error `Response` to
 * send: 413 for an oversized body, 400 for an unreadable body, invalid JSON,
 * a non-object body (null, an array, or a bare primitive), or a missing/blank
 * field.
 */
export async function readJsonStringField(
  req: Request,
  maxBytes: number,
  field: string,
): Promise<string | Response> {
  const body = await readJsonObjectBody(req, maxBytes);
  if (body instanceof Response) {
    return body;
  }
  return (
    jsonStringField(body, field) ??
    errorResponse("BAD_REQUEST", `${field} is required`, 400)
  );
}

/**
 * Read a JSON request body under a byte cap and extract one required plus
 * several optional string fields in a single pass (the body stream can only
 * be consumed once, so this can't just call {@link readJsonStringField}
 * repeatedly). Same error shapes as {@link readJsonStringField}. A missing or
 * non-string optional field resolves to `null`, never an error.
 */
export async function readJsonStringFields<K extends string>(
  req: Request,
  maxBytes: number,
  required: K,
  optional: readonly string[],
): Promise<{ [key: string]: string | null } | Response> {
  const body = await readJsonObjectBody(req, maxBytes);
  if (body instanceof Response) {
    return body;
  }

  const requiredValue = jsonStringField(body, required);
  if (requiredValue === null) {
    return errorResponse("BAD_REQUEST", `${required} is required`, 400);
  }

  const fields: { [key: string]: string | null } = {
    [required]: requiredValue,
  };
  for (const field of optional) {
    fields[field] = jsonStringField(body, field);
  }
  return fields;
}
