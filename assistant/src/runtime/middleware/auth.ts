/**
 * Auth middleware: bearer token validation, private network checks,
 * and gateway-origin verification.
 */

/**
 * Check if a hostname is a loopback address.
 */
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost"
  );
}

/**
 * @internal Exported for testing.
 *
 * Determine whether an IP address string belongs to a private/internal
 * network range:
 *   - Loopback: 127.0.0.0/8, ::1
 *   - RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 *   - Link-local: 169.254.0.0/16
 *   - IPv6 unique local: fc00::/7 (fc00::--fdff::)
 *   - IPv4-mapped IPv6 variants of all of the above (::ffff:x.x.x.x)
 */
export function isPrivateAddress(addr: string): boolean {
  // Handle IPv4-mapped IPv6 (e.g. ::ffff:10.0.0.1) -- extract the IPv4 part
  const v4Mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  const normalized = v4Mapped ? v4Mapped[1] : addr;

  // IPv4 checks
  if (normalized.includes(".")) {
    const parts = normalized.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255))
      return false;

    // Loopback: 127.0.0.0/8
    if (parts[0] === 127) return true;
    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    // 172.16.0.0/12 (172.16.x.x -- 172.31.x.x)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;
    // Link-local: 169.254.0.0/16
    if (parts[0] === 169 && parts[1] === 254) return true;

    return false;
  }

  // IPv6 checks
  const lower = normalized.toLowerCase();
  // Loopback
  if (lower === "::1") return true;
  // Unique local: fc00::/7 (fc00:: through fdff::)
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // Link-local: fe80::/10
  if (lower.startsWith("fe80")) return true;

  return false;
}

/**
 * Check if the actual peer/remote address of a connection is from a
 * private/internal network. Uses Bun's server.requestIP() to get the
 * real peer address, which cannot be spoofed unlike the Origin header.
 *
 * Accepts loopback, RFC 1918 private IPv4, link-local, and RFC 4193
 * unique-local IPv6 -- including their IPv4-mapped IPv6 forms. This
 * supports container/pod deployments (e.g. Kubernetes sidecars) where
 * gateway and runtime communicate over pod-internal private IPs.
 */
export function isPrivateNetworkPeer(
  server: {
    requestIP(
      req: Request,
    ): { address: string; family: string; port: number } | null;
  },
  req: Request,
): boolean {
  const ip = server.requestIP(req);
  if (!ip) return false;
  return isPrivateAddress(ip.address);
}

/**
 * Check if a request origin is from a private/internal network address.
 * Extracts the hostname from the Origin header and validates it against
 * isPrivateAddress(), consistent with the isPrivateNetworkPeer check.
 */
export function isPrivateNetworkOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  // No origin header (e.g., server-initiated or same-origin) -- allow
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const host = url.hostname;
    if (host === "localhost") return true;
    // URL.hostname wraps IPv6 addresses in brackets (e.g. "[::1]") -- strip them
    const rawHost =
      host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    return isPrivateAddress(rawHost);
  } catch {
    return false;
  }
}

/**
 * Extract and validate a bearer token from the Authorization header.
 * Returns the token string if present, or null.
 */
export function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  return authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
}
