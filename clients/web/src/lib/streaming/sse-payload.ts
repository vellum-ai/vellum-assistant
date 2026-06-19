/**
 * Shared helpers for normalizing HeyAPI SSE SDK payloads.
 *
 * The HeyAPI `client.sse.get<T>()` iterator yields
 * `Record<string, unknown> | string` — string when the raw `data:` field
 * is forwarded as-is, object when the SDK JSON-parses it. These helpers
 * handle both branches so each SSE consumer doesn't repeat the same
 * string-vs-object dance.
 */

/**
 * Normalize a raw HeyAPI SSE payload into a plain object, or `null` if
 * the payload is not a valid JSON object (arrays, primitives, and
 * malformed JSON are all rejected).
 */
export function normalizeSSEPayload(
  payload: Record<string, unknown> | string | unknown,
): Record<string, unknown> | null {
  if (typeof payload === "string") {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not valid JSON — fall through to null.
    }
    return null;
  }

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }

  return null;
}

/**
 * Unwrap the daemon's envelope format if present.
 *
 * The daemon wraps some SSE event payloads in `{ message: { ...fields } }`.
 * If the outer object has a `.message` property that is itself a non-array
 * object, returns the inner object. Otherwise returns the input unchanged.
 */
export function unwrapMessageEnvelope(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const msg = raw.message;
  if (msg && typeof msg === "object" && !Array.isArray(msg)) {
    return msg as Record<string, unknown>;
  }
  return raw;
}
