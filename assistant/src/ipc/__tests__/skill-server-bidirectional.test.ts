/**
 * Bidirectional RPC smoke test for the skill IPC channel.
 *
 * Spins up `SkillIpcServer` on a temp socket and connects a real
 * `SkillHostClient`. Verifies the daemon→skill direction end-to-end:
 *   - Happy path: server `sendRequest` resolves with the handler's return.
 *   - Handler-throw path: server `sendRequest` rejects with the thrown
 *     error message.
 *   - Missing-handler path: server `sendRequest` rejects with a "method
 *     not found" error.
 *   - Connection-close path: server `sendRequest` rejects with a clear
 *     "connection closed" error when the peer disconnects mid-flight.
 *
 * Sits in the assistant package (not the contracts package) because it
 * exercises both `SkillIpcServer` and `SkillHostClient` — the contracts
 * package's own tests deliberately stand up a stub server to avoid a
 * dependency on `assistant/`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { SkillHostClient } from "@vellumai/skill-host-contracts";

import {
  SKILL_IPC_DAEMON_ID_PREFIX,
  type SkillIpcConnection,
  SkillIpcServer,
} from "../skill-server.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tempDir: string | null = null;
let socketPath: string | null = null;
let server: SkillIpcServer | null = null;
let client: SkillHostClient | null = null;
let savedSkillIpcSocketDir: string | undefined;

beforeEach(() => {
  savedSkillIpcSocketDir = process.env.ASSISTANT_SKILL_IPC_SOCKET_DIR;
  tempDir = mkdtempSync(join(tmpdir(), "skill-ipc-bidir-"));
  process.env.ASSISTANT_SKILL_IPC_SOCKET_DIR = tempDir;
  socketPath = join(tempDir, "assistant-skill.sock");
});

afterEach(async () => {
  client?.close();
  client = null;
  server?.stop();
  server = null;
  if (savedSkillIpcSocketDir === undefined) {
    delete process.env.ASSISTANT_SKILL_IPC_SOCKET_DIR;
  } else {
    process.env.ASSISTANT_SKILL_IPC_SOCKET_DIR = savedSkillIpcSocketDir;
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
    socketPath = null;
  }
});

/**
 * Stand up the server, connect a client, and return the
 * server-side `SkillIpcConnection` handle once the connection is
 * established. The handle is the target the daemon's `sendRequest`
 * needs.
 */
async function startPair(): Promise<{
  server: SkillIpcServer;
  client: SkillHostClient;
  connection: SkillIpcConnection;
}> {
  if (!socketPath) throw new Error("socketPath not initialized");
  const srv = new SkillIpcServer();
  await srv.start();
  const c = new SkillHostClient({
    socketPath,
    skillId: "bidir-test",
  });
  // Stub the routes the contracts client prefetches at connect-time.
  srv.registerMethod("host.identity.getInternalAssistantId", () => "self");
  srv.registerMethod("host.identity.getAssistantName", () => null);
  srv.registerMethod("host.platform.workspaceDir", () => "/tmp/workspace");
  srv.registerMethod("host.platform.vellumRoot", () => "/tmp/vellum");
  srv.registerMethod("host.platform.runtimeMode", () => "bare-metal");

  await c.connect();
  // The server does not expose its per-socket connection map publicly
  // (it is a WeakMap keyed by the `Socket` object). Reach in via the
  // private fields — acceptable for a same-package smoke test that
  // needs the `SkillIpcConnection` handle to call `sendRequest`.
  const internals = srv as unknown as {
    clients: Set<object>;
    connections: WeakMap<object, SkillIpcConnection>;
  };
  const connections: SkillIpcConnection[] = [];
  for (const sock of internals.clients) {
    const conn = internals.connections.get(sock);
    if (conn) connections.push(conn);
  }
  if (connections.length !== 1) {
    throw new Error(
      `expected exactly one server-side connection, got ${connections.length}`,
    );
  }
  const connection = connections[0]!;
  server = srv;
  client = c;
  return { server: srv, client: c, connection };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillIpcServer.sendRequest", () => {
  test("happy path — registered handler returns a value", async () => {
    const pair = await startPair();
    pair.client.registerHandler("echo", (params) => ({ got: params }));

    const result = await pair.server.sendRequest(pair.connection, "echo", {
      hi: "there",
    });
    expect(result).toEqual({ got: { hi: "there" } });
  });

  test("happy path — async handler is awaited", async () => {
    const pair = await startPair();
    pair.client.registerHandler("delayed", async (params) => {
      await new Promise((r) => setTimeout(r, 10));
      return { delayed: true, params };
    });

    const result = await pair.server.sendRequest(pair.connection, "delayed", {
      tag: 7,
    });
    expect(result).toEqual({ delayed: true, params: { tag: 7 } });
  });

  test("handler error — rejected with the thrown message", async () => {
    const pair = await startPair();
    pair.client.registerHandler("boom", () => {
      throw new Error("kaboom");
    });

    await expect(
      pair.server.sendRequest(pair.connection, "boom"),
    ).rejects.toThrow(/kaboom/);
  });

  test("missing handler — rejected with method-not-found", async () => {
    const pair = await startPair();
    // No handler registered for "missing".

    await expect(
      pair.server.sendRequest(pair.connection, "missing"),
    ).rejects.toThrow(/method not found/);
  });

  test("connection close — rejects in-flight requests with a clear error", async () => {
    const pair = await startPair();
    // Handler that never returns so the request stays in-flight until the
    // peer disconnects.
    pair.client.registerHandler("hang", () => new Promise(() => {}));

    const inFlight = pair.server.sendRequest(pair.connection, "hang");
    // Force the client side to drop the socket. The server's "close"
    // handler will then dispose the connection state and reject every
    // pending daemon-initiated request.
    pair.client.close();

    await expect(inFlight).rejects.toThrow(/connection closed/);
  });

  test("daemon-initiated id prefix is `d:`", () => {
    // Public-constant assertion: the `d:` prefix is part of the wire
    // contract — peers (e.g. the contracts client) read it directly to
    // route inbound frames. A future rename here without updating the
    // peers would silently break bidirectional dispatch, so the
    // constant is asserted.
    expect(SKILL_IPC_DAEMON_ID_PREFIX).toBe("d:");
  });

  test("server rejects inbound skill-initiated requests whose ids start with `d:`", async () => {
    if (!socketPath) throw new Error("socketPath not initialized");
    const srv = new SkillIpcServer();
    await srv.start();
    server = srv;
    srv.registerMethod("test.echo", (params) => ({ ok: true, params }));

    // Send a request with a reserved-prefix id over a raw socket so we
    // bypass the contracts client (which never mints `d:` ids).
    const response = await new Promise<{
      id: string;
      error?: string;
      result?: unknown;
    }>((resolve, reject) => {
      const sock: Socket = connect(socketPath!);
      let buffer = "";
      let settled = false;
      const finish = (
        v: { id: string; error?: string; result?: unknown } | Error,
      ): void => {
        if (settled) return;
        settled = true;
        sock.destroy();
        if (v instanceof Error) reject(v);
        else resolve(v);
      };
      sock.on("connect", () => {
        sock.write(JSON.stringify({ id: "d:99", method: "test.echo" }) + "\n");
      });
      sock.on("data", (chunk) => {
        buffer += chunk.toString();
        const idx = buffer.indexOf("\n");
        if (idx === -1) return;
        const line = buffer.slice(0, idx).trim();
        try {
          finish(JSON.parse(line));
        } catch (err) {
          finish(err as Error);
        }
      });
      sock.on("error", (err) => finish(err));
    });

    expect(response.id).toBe("d:99");
    expect(response.result).toBeUndefined();
    expect(response.error).toMatch(/Reserved id prefix/);
  });

  test("existing skill→daemon RPCs still succeed alongside daemon→skill ones", async () => {
    const pair = await startPair();
    pair.server.registerMethod("test.add", (params) => {
      const p = params as { a: number; b: number };
      return p.a + p.b;
    });
    pair.client.registerHandler("client-echo", (params) => params);

    // Round-trip both directions concurrently.
    const [skillResult, daemonResult] = await Promise.all([
      pair.client.rawCall<number>("test.add", { a: 2, b: 3 }),
      pair.server.sendRequest(pair.connection, "client-echo", { value: "ok" }),
    ]);
    expect(skillResult).toBe(5);
    expect(daemonResult).toEqual({ value: "ok" });
  });
});
