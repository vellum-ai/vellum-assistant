/**
 * Coerce an unknown thrown value into an Error instance.
 *
 * If the value is already an Error (including subclasses like TypeError),
 * it is returned as-is. Otherwise a new Error is created with the
 * provided fallback message. This is the canonical way to normalize
 * `catch (e: unknown)` in TypeScript without unsafe casts.
 */
export function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  return new Error(fallback);
}
