/**
 * Thin wrapper around globalThis.fetch exposed through a module boundary.
 * On some platforms (Bun 1.3.9 on Linux) replacing globalThis.fetch at
 * runtime does not reliably intercept outgoing requests.  Importing fetch
 * via this module allows tests to use mock.module() for deterministic,
 * cross-platform interception.
 */
export function fetchImpl(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return globalThis.fetch(input, init);
}
