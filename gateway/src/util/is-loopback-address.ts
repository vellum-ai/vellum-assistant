import type { Server } from "bun";

/**
 * Check whether the TCP peer of a Bun HTTP request is a loopback address.
 *
 * When `trustProxy` is set, `X-Forwarded-For` is consulted to recover the real
 * client behind a trusted reverse proxy — but ONLY when the raw socket peer is
 * itself loopback (i.e. the request actually arrived over the same-host proxy
 * hop). A direct connection from a non-loopback peer is never treated as
 * loopback, so a remote caller hitting a directly-exposed gateway port cannot
 * spoof `X-Forwarded-For: 127.0.0.1` to pass a loopback gate. (This assumes the
 * proxy overwrites client-supplied X-Forwarded-For, which is the documented
 * requirement for enabling trustProxy.)
 */
export function isLoopbackPeer(
  server: Server<unknown>,
  req: Request,
  opts?: { trustProxy?: boolean },
): boolean {
  const peer = server.requestIP(req);
  const peerIsLoopback = peer ? isLoopbackAddress(peer.address) : false;

  if (opts?.trustProxy) {
    // Direct (non-proxied) connection — don't trust X-Forwarded-For at all.
    if (!peerIsLoopback) return false;
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0]?.trim();
      if (!first) return false;
      return isLoopbackAddress(first);
    }
    // Loopback socket, no X-Forwarded-For → a genuinely local direct client.
    return true;
  }

  return peerIsLoopback;
}

/**
 * Stricter loopback-only check: accepts only 127.0.0.0/8 and ::1.
 * Use this instead of isPrivateNetworkPeer for endpoints that must be
 * restricted to the local machine (e.g. token minting).
 */
export function isLoopbackAddress(addr: string): boolean {
  const v4Mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  const normalized = v4Mapped ? v4Mapped[1] : addr;

  if (normalized.includes(".")) {
    const parts = normalized.split(".").map(Number);
    if (
      parts.length !== 4 ||
      parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)
    )
      return false;
    return parts[0] === 127;
  }

  return normalized.toLowerCase() === "::1";
}
