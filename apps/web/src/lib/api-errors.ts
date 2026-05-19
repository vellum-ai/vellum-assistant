/**
 * Assert that a Response object is present.
 *
 * HeyAPI client calls return `{ data, error, response }` where `response`
 * can be `undefined` when the request never reached the server (e.g. network
 * error). This helper narrows the type and throws a descriptive error when
 * it is missing.
 */
export function assertHasResponse(
  response: Response | undefined,
  error: unknown,
  fallbackMessage: string,
): asserts response is Response {
  if (response) return;
  if (error instanceof Error) throw error;
  throw new Error(fallbackMessage);
}
