import type { Server } from "bun";

/**
 * Check whether the TCP peer of a Bun HTTP request is a loopback address.
 *
 * When `trustProxy` is set, the first entry in `X-Forwarded-For` is used
 * instead of the raw socket IP.
 */
export function isLoopbackPeer(
  server: Server<unknown>,
  req: Request,
  opts?: { trustProxy?: boolean },
): boolean {
  if (opts?.trustProxy) {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0]?.trim();
      if (!first) return false;
      return isLoopbackAddress(first);
    }
  }

  const peer = server.requestIP(req);
  if (!peer) return false;
  return isLoopbackAddress(peer.address);
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
