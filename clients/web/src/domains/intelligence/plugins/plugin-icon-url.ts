/**
 * Build the URL for a plugin's bundled icon (`GET /v1/plugins/:name/icon`,
 * exposed to clients as the gateway-proxied
 * `/v1/assistants/{assistant_id}/plugins/{name}/icon`). The path mirrors the
 * generated daemon client's `plugins_icon` operation; `iconVersion` is the
 * content-hash cache-buster the list/detail responses report, so a byte change
 * yields a fresh URL and bypasses the endpoint's immutable cache.
 *
 * The URL is same-origin and relative, so it inherits the app's origin and
 * cookie auth. Consumers render it via `<img src>`, which does not pass through
 * the HeyAPI request interceptors — so the platform gateway must serve the app
 * and proxy `/v1/assistants/{id}/...` from the same origin. The web client sets
 * no CSP; the platform-gateway CSP (vellum-assistant-platform repo) must allow
 * same-origin `/v1/...` images — flag for verification there.
 */
export function buildPluginIconUrl(
  assistantId: string,
  name: string,
  iconVersion: string,
): string {
  return `/v1/assistants/${assistantId}/plugins/${encodeURIComponent(
    name,
  )}/icon?v=${encodeURIComponent(iconVersion)}`;
}
