import type { z } from "zod";

import { BadRequestError } from "./errors.js";

/**
 * Validate a route's request body against its declared Zod schema and return
 * the parsed, typed value. Throws {@link BadRequestError} — which both the HTTP
 * and IPC adapters already map to a `400` — when the body doesn't match.
 *
 * This replaces the `body as {…}` casts in route handlers: those assert a shape
 * at compile time but validate nothing at runtime, so malformed input reaches
 * handler logic (and today surfaces as a confusing `500`, since a raw `ZodError`
 * isn't a `RouteError`). Parsing here makes the declared `requestBody` schema
 * the single source of truth for both the wire contract and runtime enforcement.
 */
export function parseBody<Schema extends z.ZodTypeAny>(
  schema: Schema,
  body: unknown,
): z.infer<Schema> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestError(formatBodyIssues(result.error));
  }
  return result.data;
}

/** Render Zod issues into a compact, PII-free `field: message` summary. */
function formatBodyIssues(error: z.ZodError): string {
  const detail = error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return `Invalid request body: ${detail}`;
}
