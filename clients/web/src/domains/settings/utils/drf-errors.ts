/**
 * Flatten a DRF validation-error body (`{ field: [msg, ...] }`) into a single
 * message per field. Non-object bodies, arrays, and fields whose value isn't a
 * non-empty array of strings are skipped, so a network failure or a 5xx HTML
 * body yields `{}` and callers can fall back to a generic message.
 */
export function extractDrfFieldErrors(err: unknown): Record<string, string> {
  if (!err || typeof err !== "object" || Array.isArray(err)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, messages] of Object.entries(err)) {
    if (Array.isArray(messages) && typeof messages[0] === "string") {
      out[key] = messages[0];
    }
  }
  return out;
}
