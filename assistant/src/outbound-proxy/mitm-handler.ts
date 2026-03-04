/**
 * MITM handler -- intercepts HTTPS CONNECT requests by terminating TLS
 * with a dynamically-issued leaf certificate, allowing the proxy to
 * read and rewrite the decrypted HTTP request before forwarding it
 * upstream over a fresh TLS connection.
 *
 * Uses a loopback TLS server on an ephemeral port with manual data
 * forwarding because Bun does not support in-process TLS termination
 * via `new TLSSocket(socket, { isServer })` or `tlsServer.emit('connection')`.
 * Additionally, pipe() has timing issues in Bun for this use case,
 * so we use explicit data event forwarding instead.
 */

import { connect as netConnect, type Socket } from "node:net";
import {
  connect as tlsConnect,
  type ConnectionOptions,
  createServer as createTlsServer,
  type TLSSocket,
} from "node:tls";

import { issueLeafCert } from "./certs.js";

/**
 * Hop-by-hop headers stripped during forwarding.
 * transfer-encoding is intentionally preserved: we forward body bytes raw,
 * so stripping it would cause upstream to misparse chunked bodies.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
]);

/**
 * Callback that receives the parsed request and returns headers to merge.
 * Return null to reject the request with 403.
 */
export type RewriteCallback = (req: {
  method: string;
  path: string;
  headers: Record<string, string>;
  hostname: string;
  port: number;
}) => Promise<Record<string, string> | null>;

interface ParsedRequest {
  method: string;
  path: string;
  httpVersion: string;
  headers: Record<string, string>;
  bodyPrefix: Buffer;
}

function parseHttpRequest(buf: Buffer): ParsedRequest | null {
  const headerEnd = buf.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;

  const headerBlock = buf.subarray(0, headerEnd).toString("utf-8");
  const lines = headerBlock.split("\r\n");
  const [method, path, httpVersion] = lines[0].split(" ", 3);

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(":");
    if (colonIdx === -1) continue;
    const key = lines[i].slice(0, colonIdx).trim().toLowerCase();
    const value = lines[i].slice(colonIdx + 1).trim();
    headers[key] = value;
  }

  return {
    method,
    path,
    httpVersion,
    headers,
    bodyPrefix: buf.subarray(headerEnd + 4),
  };
}

function serializeRequestHead(
  method: string,
  path: string,
  httpVersion: string,
  headers: Record<string, string>,
): Buffer {
  let head = `${method} ${path} ${httpVersion}\r\n`;
  for (const [key, value] of Object.entries(headers)) {
    head += `${key}: ${value}\r\n`;
  }
  head += "\r\n";
  return Buffer.from(head);
}

function filterHeaders(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      out[key] = value;
    }
  }
  // Prevent request-smuggling: when Transfer-Encoding is present,
  // Content-Length creates ambiguous framing. Drop it per RFC 7230 s3.3.3.
  if (out["transfer-encoding"]) {
    delete out["content-length"];
  }
  return out;
}

/**
 * Handle a CONNECT request via MITM TLS interception.
 */
export async function handleMitm(
  clientSocket: Socket,
  head: Buffer,
  hostname: string,
  port: number,
  caDir: string,
  rewriteCallback: RewriteCallback,
  upstreamTlsOptions?: Pick<ConnectionOptions, "ca" | "rejectUnauthorized">,
): Promise<void> {
  const { cert, key } = await issueLeafCert(caDir, hostname);

  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

  const tlsServer = createTlsServer({ cert, key }, (tlsSocket: TLSSocket) => {
    tlsServer.close();
    handleDecryptedConnection(
      tlsSocket,
      hostname,
      port,
      rewriteCallback,
      upstreamTlsOptions,
    );
  });

  await new Promise<void>((resolve, reject) => {
    tlsServer.listen(0, "127.0.0.1", () => resolve());
    tlsServer.on("error", reject);
  });

  const addr = tlsServer.address();
  if (!addr || typeof addr === "string") {
    clientSocket.destroy();
    tlsServer.close();
    return;
  }

  const bridge = netConnect(addr.port, "127.0.0.1", () => {
    if (head.length > 0) {
      bridge.write(head);
    }
  });

  // Manual bidirectional forwarding -- pipe() has timing issues in Bun
  clientSocket.on("data", (chunk) => bridge.write(chunk));
  bridge.on("data", (chunk) => clientSocket.write(chunk));

  bridge.on("end", () => clientSocket.end());
  clientSocket.on("end", () => bridge.end());

  bridge.on("error", () => {
    clientSocket.destroy();
    tlsServer.close();
  });
  clientSocket.on("error", () => {
    bridge.destroy();
    tlsServer.close();
  });
}

function handleDecryptedConnection(
  tlsSocket: TLSSocket,
  hostname: string,
  port: number,
  rewriteCallback: RewriteCallback,
  upstreamTlsOptions?: Pick<ConnectionOptions, "ca" | "rejectUnauthorized">,
): void {
  const chunks: Buffer[] = [];

  const onData = (chunk: Buffer) => {
    chunks.push(chunk);
    const combined = Buffer.concat(chunks);
    const parsed = parseHttpRequest(combined);
    if (!parsed) return;

    tlsSocket.removeListener("data", onData);
    tlsSocket.pause();
    processRequest(
      tlsSocket,
      parsed,
      hostname,
      port,
      rewriteCallback,
      upstreamTlsOptions,
    );
  };

  tlsSocket.on("data", onData);
  tlsSocket.on("error", () => tlsSocket.destroy());
}

async function processRequest(
  tlsSocket: TLSSocket,
  parsed: ParsedRequest,
  hostname: string,
  port: number,
  rewriteCallback: RewriteCallback,
  upstreamTlsOptions?: Pick<ConnectionOptions, "ca" | "rejectUnauthorized">,
): Promise<void> {
  try {
    const filteredHeaders = filterHeaders(parsed.headers);
    const rewriteResult = await rewriteCallback({
      method: parsed.method,
      path: parsed.path,
      headers: { ...filteredHeaders },
      hostname,
      port,
    });

    if (rewriteResult == null) {
      const body = "Forbidden";
      tlsSocket.write(
        `HTTP/1.1 403 Forbidden\r\nContent-Length: ${body.length}\r\nContent-Type: text/plain\r\n\r\n${body}`,
      );
      tlsSocket.end();
      return;
    }

    const finalHeaders = { ...filteredHeaders, ...rewriteResult };
    if (!finalHeaders["host"]) {
      finalHeaders["host"] = port === 443 ? hostname : `${hostname}:${port}`;
    }
    // Force close so each request gets a fresh MITM cycle with rewrite
    finalHeaders["connection"] = "close";

    const upstream = tlsConnect(
      {
        host: hostname,
        port,
        servername: hostname,
        ...upstreamTlsOptions,
      },
      () => {
        const headBuf = serializeRequestHead(
          parsed.method,
          parsed.path,
          parsed.httpVersion,
          finalHeaders,
        );
        upstream.write(headBuf);

        if (parsed.bodyPrefix.length > 0) {
          upstream.write(parsed.bodyPrefix);
        }

        // Manual forwarding -- no pipe()
        tlsSocket.on("data", (chunk) => upstream.write(chunk));
        tlsSocket.resume();
        upstream.on("data", (chunk) => tlsSocket.write(chunk));

        upstream.on("end", () => tlsSocket.end());
        tlsSocket.on("end", () => upstream.end());
      },
    );

    upstream.on("error", () => {
      if (tlsSocket.writable) {
        const body = "Bad Gateway";
        tlsSocket.write(
          `HTTP/1.1 502 Bad Gateway\r\nContent-Length: ${body.length}\r\nContent-Type: text/plain\r\n\r\n${body}`,
        );
      }
      tlsSocket.end();
    });

    tlsSocket.on("error", () => upstream.destroy());
  } catch {
    if (tlsSocket.writable) {
      const body = "Internal Server Error";
      tlsSocket.write(
        `HTTP/1.1 500 Internal Server Error\r\nContent-Length: ${body.length}\r\nContent-Type: text/plain\r\n\r\n${body}`,
      );
    }
    tlsSocket.end();
  }
}
