/**
 * CONNECT tunnel handler -- establishes a raw TCP tunnel between the
 * client and a remote host for HTTPS pass-through (no MITM).
 */

import type { IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";

/**
 * Parse and validate a CONNECT target of the form `host:port`.
 * Returns null if the target is malformed.
 * Strips brackets from IPv6 literals (e.g. `[::1]:443` -> `::1`).
 */
function parseTarget(
  url: string | undefined,
): { host: string; port: number } | null {
  if (!url) return null;

  const colonIdx = url.lastIndexOf(":");
  if (colonIdx <= 0) return null; // no port separator, or leading colon only

  let host = url.slice(0, colonIdx);
  const portStr = url.slice(colonIdx + 1);

  if (!host || !portStr) return null;

  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  // Strip brackets from IPv6 literals -- net.connect expects the raw address
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
    if (!host) return null;
  }

  return { host, port };
}

/**
 * Handle an HTTP CONNECT request by establishing a bidirectional TCP
 * tunnel to the requested target.
 */
export function handleConnect(
  req: IncomingMessage,
  clientSocket: Socket,
  head: Buffer,
): void {
  const target = parseTarget(req.url);

  if (!target) {
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  let tunnelEstablished = false;

  const upstream = connect(target.port, target.host, () => {
    tunnelEstablished = true;
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    // Forward any data already buffered by the HTTP parser
    if (head.length > 0) {
      upstream.write(head);
    }

    // Bidirectional piping
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on("error", () => {
    // Only send HTTP error if the tunnel hasn't been established yet;
    // once established the client expects raw TLS, not HTTP framing
    if (!tunnelEstablished && clientSocket.writable) {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    }
    clientSocket.destroy();
  });

  clientSocket.on("error", () => {
    upstream.destroy();
  });
}
