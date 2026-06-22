/**
 * Bun's fetch pools sockets even when the server responds `Connection:
 * close` (e.g. the Werkzeug dev platform on localhost), so the next request
 * to the same origin is written to a dead socket and hangs until its abort
 * timeout fires. Disable keepalive for loopback targets to force a fresh
 * connection per request; remote hosts are unaffected.
 */

function isLoopbackUrl(url: string): boolean {
  try {
    // WHATWG URL canonicalizes hostnames, so IPv6 loopback is always "[::1]".
    const h = new URL(url).hostname;
    return (
      h === "localhost" || h === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(h)
    );
  } catch {
    return false;
  }
}

export function loopbackSafeFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  return isLoopbackUrl(url)
    ? fetch(url, { ...init, keepalive: false })
    : fetch(url, init);
}
