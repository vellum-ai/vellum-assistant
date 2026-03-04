import { type Server } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { afterEach, describe, expect, test } from "bun:test";

import { createProxyServer } from "../outbound-proxy/index.js";

/** Start an HTTP server and return its address + cleanup handle. */
function listenEphemeral(
  server: Server,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get address"));
        return;
      }
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
    server.on("error", reject);
  });
}

/** Start a raw TCP echo server. */
function listenTcpEcho(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer((socket) => {
      socket.pipe(socket);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get address"));
        return;
      }
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
    server.on("error", reject);
  });
}

/**
 * Send an HTTP CONNECT request to the proxy and return the raw socket
 * once the tunnel is established (or an error status).
 */
function sendConnect(
  proxyPort: number,
  target: string,
): Promise<{ statusCode: number; socket: import("node:net").Socket }> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });

    let headerBuf = "";
    const onData = (chunk: Buffer) => {
      headerBuf += chunk.toString();
      const endIdx = headerBuf.indexOf("\r\n\r\n");
      if (endIdx !== -1) {
        socket.removeListener("data", onData);
        const statusLine = headerBuf.slice(0, headerBuf.indexOf("\r\n"));
        const statusCode = Number(statusLine.split(" ")[1]);
        // Push back any data after the header
        const remaining = headerBuf.slice(endIdx + 4);
        if (remaining.length > 0) {
          socket.unshift(Buffer.from(remaining));
        }
        resolve({ statusCode, socket });
      }
    };

    socket.on("data", onData);
    socket.on("error", reject);
  });
}

describe("CONNECT tunnel", () => {
  const cleanups: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(cleanups.map((c) => c.close().catch(() => {})));
    cleanups.length = 0;
  });

  test("successful CONNECT tunnel establishment", async () => {
    const echo = await listenTcpEcho();
    cleanups.push(echo);

    const proxy = createProxyServer();
    const px = await listenEphemeral(proxy);
    cleanups.push(px);

    const { statusCode, socket } = await sendConnect(
      px.port,
      `127.0.0.1:${echo.port}`,
    );
    cleanups.push({
      close: () => {
        socket.destroy();
        return Promise.resolve();
      },
    });

    expect(statusCode).toBe(200);
    socket.destroy();
  });

  test("bidirectional data flow through tunnel", async () => {
    const echo = await listenTcpEcho();
    cleanups.push(echo);

    const proxy = createProxyServer();
    const px = await listenEphemeral(proxy);
    cleanups.push(px);

    const { statusCode, socket } = await sendConnect(
      px.port,
      `127.0.0.1:${echo.port}`,
    );
    cleanups.push({
      close: () => {
        socket.destroy();
        return Promise.resolve();
      },
    });

    expect(statusCode).toBe(200);

    // Write through the tunnel and read back
    const received = await new Promise<string>((resolve, reject) => {
      socket.once("data", (chunk: Buffer) => resolve(chunk.toString()));
      socket.on("error", reject);
      socket.write("hello tunnel");
    });

    expect(received).toBe("hello tunnel");
    socket.destroy();
  });

  test("malformed target (no port) rejected with 400", async () => {
    const proxy = createProxyServer();
    const px = await listenEphemeral(proxy);
    cleanups.push(px);

    const { statusCode, socket } = await sendConnect(px.port, "example.com");
    expect(statusCode).toBe(400);
    socket.destroy();
  });

  test("malformed target (empty) rejected with 400", async () => {
    const proxy = createProxyServer();
    const px = await listenEphemeral(proxy);
    cleanups.push(px);

    // Send a CONNECT with an empty target
    const { statusCode, socket } = await sendConnect(px.port, ":443");
    expect(statusCode).toBe(400);
    socket.destroy();
  });

  test("upstream connection failure returns 502", async () => {
    const proxy = createProxyServer();
    const px = await listenEphemeral(proxy);
    cleanups.push(px);

    // Port 1 should be unreachable
    const { statusCode, socket } = await sendConnect(px.port, "127.0.0.1:1");
    expect(statusCode).toBe(502);
    socket.destroy();
  });

  test("socket cleanup on client disconnect", async () => {
    const echo = await listenTcpEcho();
    cleanups.push(echo);

    const proxy = createProxyServer();
    const px = await listenEphemeral(proxy);
    cleanups.push(px);

    const { statusCode, socket } = await sendConnect(
      px.port,
      `127.0.0.1:${echo.port}`,
    );
    expect(statusCode).toBe(200);

    // Destroy client side — upstream should clean up without crashing
    socket.destroy();

    // Give a moment for cleanup to propagate
    await new Promise((r) => setTimeout(r, 50));
  });
});
