import { createServer, type Server } from "node:net";
import { describe, expect, test } from "bun:test";

import { ensureSocketPathFree } from "./socket-cleanup.js";

// Abstract-namespace sockets are Linux-only; macOS has no abstract namespace.
describe.skipIf(process.platform !== "linux")(
  "ensureSocketPathFree — abstract namespace (Linux)",
  () => {
    test("resolves for an unbound abstract name", async () => {
      await expect(
        ensureSocketPathFree(`\0vellum-ipc/free-${process.pid}.sock`),
      ).resolves.toBeUndefined();
    });

    test("throws EADDRINUSE when a live listener holds the abstract name", async () => {
      const name = `\0vellum-ipc/busy-${process.pid}.sock`;
      const server: Server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(name, resolve);
      });

      try {
        await expect(ensureSocketPathFree(name)).rejects.toMatchObject({
          code: "EADDRINUSE",
        });
      } finally {
        server.close();
      }
    });
  },
);
