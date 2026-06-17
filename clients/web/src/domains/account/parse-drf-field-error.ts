/**
 * Shared DRF (Django REST Framework) field-error parser.
 *
 * DRF validation errors arrive in two shapes depending on whether the
 * serializer raises with a ``code=`` keyword:
 *
 *   { field: [{ code, string }] }   — preferred (machine-readable code)
 *   { field: ["message"] }          — fallback (human-readable only)
 *
 * Both the user-handle (profile.ts) and assistant-handle (handle.ts)
 * surfaces share this wire format; this helper avoids duplicating the
 * parsing logic.
 */

/**
 * Narrow an unknown value to a string-keyed record after an object check.
 * TypeScript narrows `typeof x === "object"` to `object` but doesn't allow
 * dynamic property indexing without this step.
 */
function asRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

export function parseDrfFieldError(
  body: unknown,
  fieldName: string,
  fallbackMessage: string,
): { code: string | null; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { code: null, message: fallbackMessage };
  }

  const obj = asRecord(body);

  const fieldErr: unknown = obj[fieldName];
  if (Array.isArray(fieldErr) && fieldErr.length > 0) {
    const first: unknown = fieldErr[0];
    if (typeof first === "string") {
      return { code: null, message: first };
    }
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const entry = asRecord(first);
      const codeRaw = entry.code;
      const messageRaw = entry.string ?? entry.message;
      return {
        code: typeof codeRaw === "string" ? codeRaw : null,
        message: typeof messageRaw === "string" ? messageRaw : fallbackMessage,
      };
    }
  }

  if (typeof obj.detail === "string") {
    return { code: null, message: obj.detail };
  }

  return { code: null, message: fallbackMessage };
}
