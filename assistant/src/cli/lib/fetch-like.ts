/**
 * Minimal `fetch` shape used by the plugin CLI helpers.
 *
 * Narrower than `typeof fetch` because Bun's `fetch` carries a `preconnect`
 * static these callers do not need — pinning to the wider type would force
 * every caller to construct a fully-featured Bun fetch.
 */
export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
