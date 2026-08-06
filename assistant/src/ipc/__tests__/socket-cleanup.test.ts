import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  assertNoLiveDaemonHoldingAllTransports,
  isDaemonSocketAlive,
} from "../socket-cleanup.js";

const httpHealthy = async (): Promise<boolean> => true;
const httpUnhealthy = async (): Promise<boolean> => false;

const servers: Server[] = [];
const dirs: string[] = [];

function tmpSocketPath(name = "a.sock"): string {
  const dir = mkdtempSync(join(tmpdir(), "vellum-sock-probe-"));
  dirs.push(dir);
  return join(dir, name);
}

async function listen(socketPath: string): Promise<Server> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("isDaemonSocketAlive", () => {
  test("true when a live listener holds the socket", async () => {
    const socketPath = tmpSocketPath();
    await listen(socketPath);
    expect(await isDaemonSocketAlive(socketPath)).toBe(true);
  });

  test("false when the path does not exist", async () => {
    expect(await isDaemonSocketAlive(tmpSocketPath("missing.sock"))).toBe(
      false,
    );
  });

  test("false for a stale socket file with no listener", async () => {
    const socketPath = tmpSocketPath("stale.sock");
    writeFileSync(socketPath, "");
    expect(await isDaemonSocketAlive(socketPath)).toBe(false);
  });
});

describe("assertNoLiveDaemonHoldingAllTransports", () => {
  test("throws EADDRINUSE when IPC is alive and HTTP is healthy", async () => {
    const socketPath = tmpSocketPath();
    await listen(socketPath);
    await expect(
      assertNoLiveDaemonHoldingAllTransports(httpHealthy, socketPath),
    ).rejects.toThrow(/EADDRINUSE/);
  });

  test("does not throw when IPC is alive but HTTP is unhealthy (degraded startup allowed)", async () => {
    const socketPath = tmpSocketPath();
    await listen(socketPath);
    await expect(
      assertNoLiveDaemonHoldingAllTransports(httpUnhealthy, socketPath),
    ).resolves.toBeUndefined();
  });

  test("does not throw when no socket exists, even if HTTP is healthy", async () => {
    await expect(
      assertNoLiveDaemonHoldingAllTransports(
        httpHealthy,
        tmpSocketPath("missing.sock"),
      ),
    ).resolves.toBeUndefined();
  });

  test("does not throw for a stale socket, and leaves the file in place", async () => {
    const socketPath = tmpSocketPath("stale.sock");
    writeFileSync(socketPath, "");
    await expect(
      assertNoLiveDaemonHoldingAllTransports(httpHealthy, socketPath),
    ).resolves.toBeUndefined();
    // Read-only: the stale file is left for the authoritative bind-check.
    expect(existsSync(socketPath)).toBe(true);
  });
});
