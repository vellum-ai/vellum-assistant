/**
 * Shared helpers for normalizing HeyAPI SSE SDK payloads.
 *
 * The HeyAPI `client.sse.get()` generic types `Record<string, unknown> | string`
 * for each yielded SSE data frame. Every consumer must convert that to a typed
 * object before domain-specific parsing (Zod schemas, envelope unwrapping, etc.).
 * These helpers centralise the conversion and error-coercion patterns so changes
 * propagate to all SSE consumers at once.
 */

/**
 * Convert a raw HeyAPI SSE payload into a plain object, or `null` if the
 * payload is not valid JSON or not a non-array object.
 *
 * Accepts `unknown` because the SSE async generator's yield type does not
 * always propagate the generic parameter (`client.sse.get<T>` may still
 * yield `unknown` depending on the HeyAPI version / TS inference).
 */
export function normalizeSSEPayload(
  payload: unknown,
): Record<string, unknown> | null {
  try {
    const obj: unknown =
      typeof payload === "string" ? JSON.parse(payload) : payload;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    return obj as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Coerce an unknown thrown value into an `Error`, using the provided
 * fallback message when the value is not already an `Error` instance.
 */
export function toSseError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}
