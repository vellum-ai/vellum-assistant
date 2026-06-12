/**
 * Unspoofable marker injected by a trusted edge proxy on every request it
 * proxies to the gateway. The edge must overwrite any client-supplied value of
 * the same name, so a remote caller can neither forge nor strip it.
 *
 * The gateway-side guard (this constant + the checks in the guardian-init and
 * pair handlers) is inert unless an edge actually sets the header.
 *
 * Loopback-only endpoints (`/v1/guardian/init`, `/v1/pair`) treat its presence
 * as proof that the request did NOT arrive directly from a local loopback
 * client: it was forwarded by the edge proxy, possibly from a remote browser
 * over a tunnel. If every hop in that chain is loopback, the raw TCP peer can
 * be 127.0.0.1 and a peer-IP loopback check alone would misclassify the caller
 * as local. This marker is the reliable signal instead — and crucially it does
 * NOT depend on the spoofable leftmost `X-Forwarded-For` entry.
 *
 * This mirrors the Velay bridge's `VELAY_FORWARDED_HEADER` defense.
 *
 * NOTE: If an edge proxy sets this marker, keep its header literal in sync
 * with this constant.
 */
export const EDGE_FORWARDED_HEADER = "x-vellum-edge-forwarded" as const;

/**
 * True when the request carries the unspoofable edge-proxy marker rather than
 * being sent directly by a local loopback client.
 */
export function requestArrivedViaEdgeProxy(req: Request): boolean {
  return req.headers.get(EDGE_FORWARDED_HEADER) !== null;
}
