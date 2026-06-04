/**
 * Unspoofable marker injected by the self-hosted, SPA-serving nginx edge on
 * every request it proxies to the gateway. nginx sets it via `proxy_set_header`,
 * which REPLACES any client-supplied value of the same name — so a remote
 * caller can neither forge nor strip it.
 *
 * The gateway-side guard (this constant + the checks in the guardian-init and
 * pair handlers) lands first and is inert until an edge actually sets the
 * header — i.e. it ships dark. The nginx injection
 * (`proxy_set_header X-Vellum-Edge-Forwarded "1"`) is added with the
 * SPA-serving edge itself.
 *
 * Loopback-only endpoints (`/v1/guardian/init`, `/v1/pair`) treat its presence
 * as proof that the request did NOT arrive directly from a local loopback
 * client: it was forwarded by the edge proxy, possibly from a remote browser
 * over a tunnel (e.g. ngrok). Because every hop in that chain is loopback
 * (browser → tunnel agent → nginx@127.0.0.1 → gateway@127.0.0.1), the raw TCP
 * peer is 127.0.0.1 and a peer-IP loopback check alone would misclassify the
 * caller as local. This marker is the reliable signal instead — and crucially
 * it does NOT depend on the spoofable leftmost `X-Forwarded-For` entry.
 *
 * This mirrors the Velay bridge's `VELAY_FORWARDED_HEADER` defense, for the
 * self-hosted nginx edge. Only that edge sets this header; platform/vembda
 * ingress does not, so guards may check it unconditionally across deploy modes.
 *
 * NOTE: The literal value is mirrored as a hardcoded string in the nginx
 * config in cli/src/commands/client.ts (`proxy_set_header X-Vellum-Edge-Forwarded`).
 * Keep the two in sync.
 */
export const EDGE_FORWARDED_HEADER = "x-vellum-edge-forwarded" as const;

/**
 * True when the request carries the unspoofable edge-proxy marker, i.e. it was
 * forwarded by the self-hosted nginx edge rather than sent directly by a local
 * loopback client.
 */
export function requestArrivedViaEdgeProxy(req: Request): boolean {
  return req.headers.get(EDGE_FORWARDED_HEADER) !== null;
}
