import type { z } from "zod";

import { BadRequestError } from "./errors.js";

/**
 * Validate a route's request body against its declared Zod schema and return
 * the parsed, typed value. Throws {@link BadRequestError} — which both the HTTP
 * and IPC adapters map to a `400` — when the body doesn't match its schema.
 *
 * The route's declared `requestBody` schema is the single source of truth for
 * both the OpenAPI/wire contract and runtime validation, so malformed input is
 * rejected with a `400` rather than flowing into handler logic.
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
