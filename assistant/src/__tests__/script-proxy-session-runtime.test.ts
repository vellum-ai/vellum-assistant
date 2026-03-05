import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, test } from "bun:test";

import {
  createSession,
  startSession,
  stopAllSessions,
  stopSession,
} from "../tools/network/script-proxy/session-manager.js";

let upstreamServer: Server | null = null;

afterEach(async () => {
  await stopAllSessions();
  if (upstreamServer) {
    await new Promise<void>((resolve) => {
      upstreamServer!.close(() => resolve());
    });
    upstreamServer = null;
  }
});

/**
 * Start a simple HTTP server that responds with a known body on every request.
 * Listens on an ephemeral port on 127.0.0.1.
 */
function startUpstream(
  responseBody: string,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(responseBody);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get upstream address"));
        return;
      }
      resolve({ server, port: addr.port });
    });
    server.on("error", reject);
  });
}

/**
 * Make an HTTP GET through a proxy using the absolute-URL form
 * that forward proxies expect.
 */
function proxyGet(
  proxyPort: number,
  targetUrl: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: proxyPort,
        // Forward proxies expect the full absolute URL as the path
        path: targetUrl,
        method: "GET",
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("session-manager runtime proxy", () => {
  const CONV_ID = "conv-runtime-test";
  const CRED_IDS: string[] = [];

  test("proxy session forwards HTTP requests to upstream", async () => {
    const expectedBody = "hello from upstream";

    // 1. Start a local upstream HTTP server
    const upstream = await startUpstream(expectedBody);
    upstreamServer = upstream.server;

    // 2. Create and start a proxy session
    const session = createSession(CONV_ID, CRED_IDS);
    const started = await startSession(session.id);
    expect(started.port).toBeGreaterThan(0);

    // 3. Make an HTTP request through the proxy to the upstream
    const targetUrl = `http://127.0.0.1:${upstream.port}/test-path`;
    const response = await proxyGet(started.port!, targetUrl);

    // 4. Assert the response matches the upstream's response
    expect(response.status).toBe(200);
    expect(response.body).toBe(expectedBody);

    // 5. Stop the proxy session
    await stopSession(session.id);
  });

  test("proxy session returns 400 for non-HTTP protocol requests", async () => {
    const session = createSession(CONV_ID, CRED_IDS);
    const started = await startSession(session.id);

    // Sending a relative path (not absolute-URL form) should be rejected
    const response = await proxyGet(started.port!, "/relative-path");
    expect(response.status).toBe(400);

    await stopSession(session.id);
  });
});
