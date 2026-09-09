/**
 * Strict loopback check for CES HTTP peers: 127.0.0.0/8 and ::1.
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is treated as IPv4.
 */
export function isLoopbackAddress(addr: string): boolean {
  const v4Mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  const normalized = v4Mapped ? v4Mapped[1] : addr;

  if (normalized.includes(".")) {
    const parts = normalized.split(".").map(Number);
    if (
      parts.length !== 4 ||
      parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)
    ) {
      return false;
    }
    return parts[0] === 127;
  }

  return normalized.toLowerCase() === "::1";
}

export function isCesHttpProbePath(pathname: string): boolean {
  return pathname === "/healthz" || pathname === "/readyz";
}
