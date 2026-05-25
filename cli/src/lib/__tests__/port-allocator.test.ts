import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "net";

import { findOpenPort } from "../port-allocator.js";

const HOST = "127.0.0.1";

async function bindBlocker(port: number, host: string = HOST): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.once("listening", () => resolve(server));
    server.listen(port, host);
  });
}

async function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function getEphemeralPort(): Promise<number> {
  const server = await new Promise<Server>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.once("listening", () => resolve(s));
    s.listen(0, HOST);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string" || addr.port == null) {
    throw new Error("Could not obtain ephemeral port");
  }
  const port = addr.port;
  await closeServer(server);
  return port;
}

describe("findOpenPort", () => {
  test("returns the preferred port when it is free", async () => {
    const port = await getEphemeralPort();
    const result = await findOpenPort(port, { host: HOST });
    expect(result).toBe(port);
  });

  test("walks past an in-use port and returns the next free one", async () => {
    const blocked = await getEphemeralPort();
    const blocker = await bindBlocker(blocked);
    try {
      const result = await findOpenPort(blocked, { host: HOST });
      expect(result).toBeGreaterThan(blocked);
      expect(result).toBeLessThanOrEqual(blocked + 50);
    } finally {
      await closeServer(blocker);
    }
  });

  test("walks past two consecutive in-use ports", async () => {
    const first = await getEphemeralPort();
    const blockerA = await bindBlocker(first);
    let blockerB: Server | null = null;
    try {
      // Best-effort grab of the next consecutive port; if the kernel
      // handed it to someone else just before we got here, that's still a
      // valid "two consecutive blockers" scenario for the walk.
      try {
        blockerB = await bindBlocker(first + 1);
      } catch {
        blockerB = null;
      }
      const result = await findOpenPort(first, { host: HOST });
      expect(result).toBeGreaterThan(first + (blockerB ? 1 : 0));
    } finally {
      await closeServer(blockerA);
      if (blockerB) await closeServer(blockerB);
    }
  });

  test("throws when the entire requested window is in use", async () => {
    const blocked = await getEphemeralPort();
    const blocker = await bindBlocker(blocked);
    try {
      await expect(
        findOpenPort(blocked, { host: HOST, maxAttempts: 1 }),
      ).rejects.toThrow(/no open port/i);
    } finally {
      await closeServer(blocker);
    }
  });

  test("rejects non-integer or out-of-range preferred port", async () => {
    await expect(findOpenPort(0, { host: HOST })).rejects.toThrow(
      /not a valid TCP port/i,
    );
    await expect(findOpenPort(65536, { host: HOST })).rejects.toThrow(
      /not a valid TCP port/i,
    );
    await expect(findOpenPort(1.5, { host: HOST })).rejects.toThrow(
      /not a valid TCP port/i,
    );
  });

  test("rejects non-positive maxAttempts", async () => {
    await expect(
      findOpenPort(20100, { host: HOST, maxAttempts: 0 }),
    ).rejects.toThrow(/maxAttempts/i);
  });

  test("does not leak the probe port — port is rebindable after resolution", async () => {
    const port = await getEphemeralPort();
    const found = await findOpenPort(port, { host: HOST });
    expect(found).toBe(port);
    // If the probe leaked a listener on `port`, this would throw EADDRINUSE.
    const reuse = await bindBlocker(found);
    await closeServer(reuse);
  });
});
