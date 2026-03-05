import { mkdtemp, readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import {
  createProxyServer,
  ensureLocalCA,
  getCAPath,
  issueLeafCert,
  type RewriteCallback,
  type RouteDecision,
} from "../outbound-proxy/index.js";

let dataDir: string;
let caDir: string;
let caCert: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "mitm-test-"));
  await ensureLocalCA(dataDir);
  caDir = join(dataDir, "proxy-ca");
  caCert = await readFile(getCAPath(dataDir), "utf-8");
});

/**
 * Create a local HTTPS server using a leaf cert issued by our test CA.
 * Echoes request info as JSON.
 */
async function createUpstreamHttpsServer(): Promise<{
  port: number;
  close: () => void;
  lastRequest: () => {
    method: string;
    url: string;
    headers: Record<string, string>;
  } | null;
}> {
  const { cert, key } = await issueLeafCert(caDir, "localhost");
  let lastReq: {
    method: string;
    url: string;
    headers: Record<string, string>;
  } | null = null;

  const server = createHttpsServer({ cert, key }, (req, res) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) {
        headers[k] = Array.isArray(v) ? v.join(", ") : v;
      }
    }
    lastReq = { method: req.method ?? "GET", url: req.url ?? "/", headers };
    const body = JSON.stringify(lastReq);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    });
    res.end(body);
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("no addr"));
        return;
      }
      resolve({
        port: addr.port,
        close: () => server.close(),
        lastRequest: () => lastReq,
      });
    });
    server.on("error", reject);
  });
}

function listenEphemeral(
  server: Server,
): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("no addr"));
        return;
      }
      resolve({ port: addr.port, close: () => server.close() });
    });
    server.on("error", reject);
  });
}

/**
 * Send CONNECT -> TLS handshake -> HTTP request through the proxy.
 * Returns the response. Destroys all sockets when done.
 */
function connectAndRequest(
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  method: string,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<{
  statusCode: number;
  body: string;
  headers: Record<string, string>;
}> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("connectAndRequest timed out"));
    }, 8000);

    const socket = connect(proxyPort, "127.0.0.1", () => {
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`,
      );
    });

    let headerBuf = "";
    const onData = (chunk: Buffer) => {
      headerBuf += chunk.toString();
      const endIdx = headerBuf.indexOf("\r\n\r\n");
      if (endIdx === -1) return;

      socket.removeListener("data", onData);
      const statusLine = headerBuf.slice(0, headerBuf.indexOf("\r\n"));
      const connectStatus = Number(statusLine.split(" ")[1]);

      if (connectStatus !== 200) {
        clearTimeout(timeout);
        socket.destroy();
        reject(new Error(`CONNECT failed with ${connectStatus}`));
        return;
      }

      const tlsSocket = tlsConnect(
        { socket, servername: targetHost, ca: caCert },
        () => {
          const headerLines = [
            `${method} ${path} HTTP/1.1`,
            `Host: ${targetHost}:${targetPort}`,
            "Connection: close",
          ];
          for (const [k, v] of Object.entries(extraHeaders)) {
            headerLines.push(`${k}: ${v}`);
          }
          tlsSocket.write(headerLines.join("\r\n") + "\r\n\r\n");
        },
      );

      let responseBuf = "";
      let resolved = false;

      const tryResolve = () => {
        if (resolved) return;
        const headerEndIdx = responseBuf.indexOf("\r\n\r\n");
        if (headerEndIdx === -1) return;

        const responseHeaderBlock = responseBuf.slice(0, headerEndIdx);
        const bodyPart = responseBuf.slice(headerEndIdx + 4);
        const responseLines = responseHeaderBlock.split("\r\n");
        const statusCode = Number(responseLines[0].split(" ")[1]);
        const responseHeaders: Record<string, string> = {};
        for (let i = 1; i < responseLines.length; i++) {
          const ci = responseLines[i].indexOf(":");
          if (ci > 0) {
            responseHeaders[
              responseLines[i].slice(0, ci).trim().toLowerCase()
            ] = responseLines[i].slice(ci + 1).trim();
          }
        }

        const cl = responseHeaders["content-length"];
        if (cl !== undefined && bodyPart.length >= Number(cl)) {
          resolved = true;
          clearTimeout(timeout);
          tlsSocket.destroy();
          resolve({
            statusCode,
            body: bodyPart.slice(0, Number(cl)),
            headers: responseHeaders,
          });
        }
      };

      tlsSocket.on("data", (chunk: Buffer) => {
        responseBuf += chunk.toString("utf-8");
        tryResolve();
      });

      tlsSocket.on("end", () => {
        if (!resolved) {
          clearTimeout(timeout);
          const headerEndIdx = responseBuf.indexOf("\r\n\r\n");
          if (headerEndIdx === -1) {
            reject(new Error("No complete HTTP response"));
            return;
          }
          const responseHeaderBlock = responseBuf.slice(0, headerEndIdx);
          const body = responseBuf.slice(headerEndIdx + 4);
          const responseLines = responseHeaderBlock.split("\r\n");
          const statusCode = Number(responseLines[0].split(" ")[1]);
          const responseHeaders: Record<string, string> = {};
          for (let i = 1; i < responseLines.length; i++) {
            const ci = responseLines[i].indexOf(":");
            if (ci > 0) {
              responseHeaders[
                responseLines[i].slice(0, ci).trim().toLowerCase()
              ] = responseLines[i].slice(ci + 1).trim();
            }
          }
          resolve({ statusCode, body, headers: responseHeaders });
        }
      });

      tlsSocket.on("error", (e) => {
        if (!resolved) {
          clearTimeout(timeout);
          reject(e);
        }
      });
    };

    socket.on("data", onData);
    socket.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
  });
}

describe("MITM handler", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {}
    }
    cleanups.length = 0;
  });

  test("MITM intercepts and can read/rewrite headers", async () => {
    const upstream = await createUpstreamHttpsServer();
    cleanups.push(upstream.close);

    const rewriteCallback: RewriteCallback = async (req) => {
      return {
        "x-injected-token": "secret-123",
        "x-original-host": req.hostname,
      };
    };

    const proxy = createProxyServer({
      mitmHandler: {
        caDir,
        shouldIntercept: (): RouteDecision => ({
          action: "mitm",
          reason: "mitm:credential_injection",
        }),
        rewriteCallback,
        upstreamTlsOptions: { ca: caCert },
      },
    });
    const px = await listenEphemeral(proxy);
    cleanups.push(px.close);

    const { statusCode, body } = await connectAndRequest(
      px.port,
      "localhost",
      upstream.port,
      "GET",
      "/test",
    );

    expect(statusCode).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.headers["x-injected-token"]).toBe("secret-123");
    expect(parsed.headers["x-original-host"]).toBe("localhost");
    expect(parsed.url).toBe("/test");
  });

  test("response streaming works through MITM", async () => {
    const upstream = await createUpstreamHttpsServer();
    cleanups.push(upstream.close);

    const proxy = createProxyServer({
      mitmHandler: {
        caDir,
        shouldIntercept: (): RouteDecision => ({
          action: "mitm",
          reason: "mitm:credential_injection",
        }),
        rewriteCallback: async () => ({}),
        upstreamTlsOptions: { ca: caCert },
      },
    });
    const px = await listenEphemeral(proxy);
    cleanups.push(px.close);

    const { statusCode, body, headers } = await connectAndRequest(
      px.port,
      "localhost",
      upstream.port,
      "GET",
      "/stream-test",
      { accept: "application/json" },
    );

    expect(statusCode).toBe(200);
    expect(headers["content-type"]).toBe("application/json");
    const parsed = JSON.parse(body);
    expect(parsed.url).toBe("/stream-test");
    expect(parsed.method).toBe("GET");
  });

  test("original request reaches upstream with modifications", async () => {
    const upstream = await createUpstreamHttpsServer();
    cleanups.push(upstream.close);

    const rewriteCallback: RewriteCallback = async () => {
      return { authorization: "Bearer my-secret-token" };
    };

    const proxy = createProxyServer({
      mitmHandler: {
        caDir,
        shouldIntercept: (): RouteDecision => ({
          action: "mitm",
          reason: "mitm:credential_injection",
        }),
        rewriteCallback,
        upstreamTlsOptions: { ca: caCert },
      },
    });
    const px = await listenEphemeral(proxy);
    cleanups.push(px.close);

    const { statusCode, body } = await connectAndRequest(
      px.port,
      "localhost",
      upstream.port,
      "GET",
      "/api/data",
      { "x-custom": "original-value" },
    );

    expect(statusCode).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.headers["authorization"]).toBe("Bearer my-secret-token");
    expect(parsed.headers["x-custom"]).toBe("original-value");

    const last = upstream.lastRequest();
    expect(last).not.toBeNull();
    expect(last!.headers["authorization"]).toBe("Bearer my-secret-token");
    expect(last!.headers["x-custom"]).toBe("original-value");
  });

  test("non-intercepted requests pass through unchanged via tunnel", async () => {
    const upstream = await createUpstreamHttpsServer();
    cleanups.push(upstream.close);

    const interceptedHosts: string[] = [];
    const proxy = createProxyServer({
      mitmHandler: {
        caDir,
        shouldIntercept: (hostname): RouteDecision => {
          interceptedHosts.push(hostname);
          return { action: "tunnel", reason: "tunnel:no_rewrite" };
        },
        rewriteCallback: async () => ({ "x-should-not-appear": "true" }),
      },
    });
    const px = await listenEphemeral(proxy);
    cleanups.push(px.close);

    // With shouldIntercept=false, the tunnel passes through without MITM.
    // The client's TLS handshake happens directly with the upstream server.
    const result = await new Promise<{ statusCode: number; body: string }>(
      (resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("tunnel test timed out")),
          8000,
        );

        const socket = connect(px.port, "127.0.0.1", () => {
          socket.write(
            `CONNECT localhost:${upstream.port} HTTP/1.1\r\nHost: localhost:${upstream.port}\r\n\r\n`,
          );
        });

        let headerBuf = "";
        const onData = (chunk: Buffer) => {
          headerBuf += chunk.toString();
          const endIdx = headerBuf.indexOf("\r\n\r\n");
          if (endIdx === -1) return;
          socket.removeListener("data", onData);
          const connectStatus = Number(
            headerBuf.slice(0, headerBuf.indexOf("\r\n")).split(" ")[1],
          );

          if (connectStatus !== 200) {
            clearTimeout(timeout);
            socket.destroy();
            reject(new Error(`CONNECT failed: ${connectStatus}`));
            return;
          }

          const tlsSocket = tlsConnect(
            { socket, servername: "localhost", ca: caCert },
            () => {
              tlsSocket.write(
                `GET /tunnel-check HTTP/1.1\r\nHost: localhost:${upstream.port}\r\nConnection: close\r\n\r\n`,
              );
            },
          );

          const chunks: Buffer[] = [];
          tlsSocket.on("data", (c: Buffer) => chunks.push(c));
          tlsSocket.on("end", () => {
            clearTimeout(timeout);
            const raw = Buffer.concat(chunks).toString("utf-8");
            const hEnd = raw.indexOf("\r\n\r\n");
            if (hEnd === -1) {
              reject(new Error("Incomplete response"));
              return;
            }
            resolve({
              statusCode: Number(
                raw.slice(0, hEnd).split("\r\n")[0].split(" ")[1],
              ),
              body: raw.slice(hEnd + 4),
            });
          });
          tlsSocket.on("error", (e) => {
            clearTimeout(timeout);
            reject(e);
          });
        };

        socket.on("data", onData);
        socket.on("error", (e) => {
          clearTimeout(timeout);
          reject(e);
        });
      },
    );

    expect(result.statusCode).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.headers["x-should-not-appear"]).toBeUndefined();
    expect(parsed.url).toBe("/tunnel-check");
    expect(interceptedHosts).toContain("localhost");
  });

  test("rewriteCallback returning null rejects with 403", async () => {
    const upstream = await createUpstreamHttpsServer();
    cleanups.push(upstream.close);

    const proxy = createProxyServer({
      mitmHandler: {
        caDir,
        shouldIntercept: (): RouteDecision => ({
          action: "mitm",
          reason: "mitm:credential_injection",
        }),
        rewriteCallback: async () => null,
        upstreamTlsOptions: { ca: caCert },
      },
    });
    const px = await listenEphemeral(proxy);
    cleanups.push(px.close);

    const { statusCode, body } = await connectAndRequest(
      px.port,
      "localhost",
      upstream.port,
      "GET",
      "/forbidden",
    );

    expect(statusCode).toBe(403);
    expect(body).toContain("Forbidden");
  });
});
