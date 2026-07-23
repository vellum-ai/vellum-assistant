import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createConnection, createServer, type Server } from "node:net";

import {
  ABSTRACT_IPC_ENV,
  abstractSocketPath,
  isAbstractIpcEnabled,
  isAbstractSocketPath,
} from "./abstract-socket.js";
import { ensureSocketDir } from "./socket-watchdog.js";

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ABSTRACT_IPC_ENV];
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[ABSTRACT_IPC_ENV];
  } else {
    process.env[ABSTRACT_IPC_ENV] = savedEnv;
  }
});

describe("isAbstractIpcEnabled", () => {
  test("off by default", () => {
    delete process.env[ABSTRACT_IPC_ENV];
    expect(isAbstractIpcEnabled()).toBe(false);
  });

  test.each(["1", "true", " TRUE "])("enabled for %j", (value) => {
    process.env[ABSTRACT_IPC_ENV] = value;
    expect(isAbstractIpcEnabled()).toBe(true);
  });

  test.each(["0", "false", "", "yes"])("disabled for %j", (value) => {
    process.env[ABSTRACT_IPC_ENV] = value;
    expect(isAbstractIpcEnabled()).toBe(false);
  });
});

describe("abstractSocketPath", () => {
  test("prefixes the NUL-byte namespace", () => {
    const path = abstractSocketPath("gateway.sock");
    expect(path).toBe("\0vellum-ipc/gateway.sock");
    expect(isAbstractSocketPath(path)).toBe(true);
  });

  test("filesystem paths are not abstract", () => {
    expect(isAbstractSocketPath("/run/gateway-ipc/gateway.sock")).toBe(false);
  });
});

describe("ensureSocketDir", () => {
  test("no-ops on abstract paths instead of throwing on the NUL byte", () => {
    expect(() =>
      ensureSocketDir(abstractSocketPath("gateway.sock")),
    ).not.toThrow();
  });
});

// Abstract-namespace sockets are Linux-only; on macOS bind() rejects them.
// CI (Linux) exercises the real kernel round-trip, which is the load-bearing
// claim of this POC: Bun's node:net binds and connects abstract names.
describe.skipIf(process.platform !== "linux")(
  "abstract socket round-trip (Linux)",
  () => {
    test("listen + connect + echo over an abstract name", async () => {
      const name = abstractSocketPath(`test-${process.pid}.sock`);
      const server: Server = createServer((socket) => {
        socket.on("data", (chunk) => socket.write(chunk));
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(name, resolve);
      });

      try {
        const echoed = await new Promise<string>((resolve, reject) => {
          const client = createConnection(name, () => {
            client.write("ping");
          });
          client.once("data", (chunk) => {
            client.end();
            resolve(chunk.toString());
          });
          client.once("error", reject);
        });
        expect(echoed).toBe("ping");
      } finally {
        server.close();
      }
    });
  },
);
