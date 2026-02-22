import { networkInterfaces } from 'node:os';

/**
 * Returns the local IPv4 address most likely to be reachable from other
 * devices on the same LAN.
 *
 * Priority order:
 *   1. en0 (Wi-Fi on macOS)
 *   2. en1 (secondary network on macOS)
 *   3. First non-loopback IPv4 on any interface
 *
 * Skips link-local addresses (169.254.x.x) and IPv6.
 * Returns null if no suitable address is found (e.g. no network).
 */
export function getLocalIPv4(): string | null {
  const ifaces = networkInterfaces();

  // Priority interfaces in order
  const priorityInterfaces = ['en0', 'en1'];

  for (const ifName of priorityInterfaces) {
    const addrs = ifaces[ifName];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal && !isLinkLocal(addr.address)) {
        return addr.address;
      }
    }
  }

  // Fallback: first non-loopback, non-link-local IPv4 on any interface
  for (const [, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal && !isLinkLocal(addr.address)) {
        return addr.address;
      }
    }
  }

  return null;
}

/** Returns true for IPv4 link-local addresses (169.254.x.x). */
function isLinkLocal(address: string): boolean {
  return address.startsWith('169.254.');
}
