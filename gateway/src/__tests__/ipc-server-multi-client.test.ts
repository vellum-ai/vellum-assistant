import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "./test-preload.js";

import { GatewayIpcServer, type IpcRoute } from "../ipc/server.js";

// macOS caps Unix socket paths at sizeof(sun_path)-1 == 103 chars, so the
// shared test-preload temp dir is too long. Mint our own short path under
// the system tmpdir for this test.
const shortRoot = mkdtempSync(join(tmpdir(), "vmc-"));
const socketPath = join(shortRoot, "g.sock");

function connectClient(path: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const client: Socket = createConnection(path, () => resolve(client));
    client.on("error", reject);
  });
}

function sendRequest(
  client: Socket,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ id: string; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const id = randomBytes(4).toString("hex");
    let buffer = "";

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        client.off("data", onData);
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(err);
        }
      }
    };

    client.on("data", onData);
    client.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

describe("GatewayIpcServer multi-client behavior", () => {
  let server: InstanceType<typeof GatewayIpcServer> | undefined;
  const sockets: Socket[] = [];

  // The handler gates its response on a release latch so the test can
  // assert that an in-flight request from client A is NOT rejected when
  // client B connects mid-flight.
  let releaseSlow: (() => void) | undefined;

  const slowRoute: IpcRoute = {
    method: "slow_echo",
    handler: async (params?: Record<string, unknown>) => {
      await new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
      return { echoed: params?.value ?? null };
    },
  };

  const fastRoute: IpcRoute = {
    method: "fast_ping",
    handler: () => ({ ok: true }),
  };

  beforeEach(async () => {
    if (existsSync(socketPath)) rmSync(socketPath);
    releaseSlow = undefined;
    server = new GatewayIpcServer([slowRoute, fastRoute]);
    (server as unknown as { socketPath: string }).socketPath = socketPath;
    server.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  afterEach(() => {
    for (const s of sockets) s.destroy();
    sockets.length = 0;
    server?.stop();
    server = undefined;
    if (existsSync(socketPath)) rmSync(socketPath);
  });

  test("a new client connection does not destroy in-flight requests on existing clients", async () => {
    const persistent = await connectClient(socketPath);
    sockets.push(persistent);

    const slowResultPromise = sendRequest(persistent, "slow_echo", {
      value: "abc",
    });

    // Give the server a tick to register the pending handler before the
    // second connection arrives.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const oneShot = await connectClient(socketPath);
    sockets.push(oneShot);

    // Do a full request/response on the one-shot connection. Before the
    // fix, this would destroy `persistent` and `slowResultPromise` would
    // never resolve (the persistent socket would close mid-flight).
    const fastResult = await sendRequest(oneShot, "fast_ping");
    expect(fastResult.error).toBeUndefined();
    expect(fastResult.result).toEqual({ ok: true });

    oneShot.destroy();
    sockets.splice(sockets.indexOf(oneShot), 1);

    // Release the slow handler — the persistent socket must still be
    // alive to deliver the response.
    expect(releaseSlow).toBeDefined();
    releaseSlow!();

    const slowResult = await slowResultPromise;
    expect(slowResult.error).toBeUndefined();
    expect(slowResult.result).toEqual({ echoed: "abc" });
  });
});
