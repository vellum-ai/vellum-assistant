/**
 * Build structured IPC params from Commander opts.
 *
 * Strips CLI-only keys (`json`, `verbose`, etc.) and wraps the remaining
 * key/value pairs into `{ queryParams }` for the transport-agnostic
 * route handler.  Callers that also need `pathParams` or `body` can
 * spread the result and add them.
 */

/** Keys that are CLI-presentation concerns, not IPC params. */
const CLI_ONLY_KEYS = new Set(["json", "verbose"]);

export function optsToQueryParams(
  opts: Record<string, unknown>,
): { queryParams: Record<string, string> } {
  const queryParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts)) {
    if (CLI_ONLY_KEYS.has(k)) continue;
    if (typeof v === "string") queryParams[k] = v;
  }
  return { queryParams };
}
