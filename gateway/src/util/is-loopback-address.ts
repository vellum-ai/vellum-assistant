import type { Server } from "bun";

/**
 * Check whether the TCP peer of a Bun HTTP request is a loopback address.
 *
 * Loopback auth fallback is direct-only. A same-host tunnel or reverse proxy
 * can make the raw socket peer look local, so any request carrying forwarding
 * headers is treated as non-local regardless of its peer IP.
 */
export function isLoopbackPeer(server: Server<unknown>, req: Request): boolean {
  if (hasForwardingHeaders(req)) return false;

  const peer = server.requestIP(req);
  return peer ? isLoopbackAddress(peer.address) : false;
}

function hasForwardingHeaders(req: Request): boolean {
  return (
    req.headers.has("forwarded") ||
    req.headers.has("via") ||
    req.headers.has("x-forwarded-for") ||
    req.headers.has("x-forwarded-host") ||
    req.headers.has("x-forwarded-port") ||
    req.headers.has("x-forwarded-proto") ||
    req.headers.has("x-real-ip")
  );
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
