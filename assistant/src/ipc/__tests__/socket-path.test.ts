import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ensureSocketPathFree } from "../socket-cleanup.js";
import { resolveIpcSocketPath } from "../socket-path.js";

// Fake workspace under tmpdir so the live-workspace guard accepts it.
const WS_DIR = join(tmpdir(), "vellum-workspace-test");

let savedWorkspaceDir: string | undefined;
let savedGatewayIpcSocketDir: string | undefined;

beforeEach(() => {
  savedWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  savedGatewayIpcSocketDir = process.env.GATEWAY_IPC_SOCKET_DIR;
});

afterEach(() => {
  if (savedWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = savedWorkspaceDir;
  }
  if (savedGatewayIpcSocketDir === undefined) {
    delete process.env.GATEWAY_IPC_SOCKET_DIR;
  } else {
    process.env.GATEWAY_IPC_SOCKET_DIR = savedGatewayIpcSocketDir;
  }
});

describe("resolveIpcSocketPath", () => {
  test("uses env var override when set", () => {
    process.env.GATEWAY_IPC_SOCKET_DIR = "/run/gateway-ipc";
    process.env.VELLUM_WORKSPACE_DIR = WS_DIR;

    const resolved = resolveIpcSocketPath("gateway");

    expect(resolved.source).toBe("env-override");
    expect(resolved.path).toBe("/run/gateway-ipc/gateway.sock");
  });

  test("ignores empty env var override", () => {
    process.env.GATEWAY_IPC_SOCKET_DIR = "  ";
    process.env.VELLUM_WORKSPACE_DIR = WS_DIR;

    const resolved = resolveIpcSocketPath("gateway");

    expect(resolved.source).toBe("workspace");
    expect(resolved.path).toBe(join(WS_DIR, "gateway.sock"));
  });

  test("uses workspace path by default", () => {
    delete process.env.GATEWAY_IPC_SOCKET_DIR;
    process.env.VELLUM_WORKSPACE_DIR = WS_DIR;

    const resolved = resolveIpcSocketPath("gateway");

    expect(resolved.source).toBe("workspace");
    expect(resolved.path).toBe(join(WS_DIR, "gateway.sock"));
  });

  test("falls back to tmpdir when workspace path exceeds AF_UNIX limit", () => {
    delete process.env.GATEWAY_IPC_SOCKET_DIR;
    // 90-char workspace dir + /gateway.sock = well over 103 bytes
    process.env.VELLUM_WORKSPACE_DIR = join(
      tmpdir(),
      "a".repeat(90),
      "workspace",
    );

    const resolved = resolveIpcSocketPath("gateway");

    expect(["tmp-hash", "tmp-short-hash"]).toContain(resolved.source);
    expect(resolved.path.startsWith(tmpdir())).toBe(true);
  });

  test("derives a hyphenated socket name's env var and filename", () => {
    process.env.EXAMPLE_SERVICE_IPC_SOCKET_DIR = "/run/example-ipc";
    process.env.VELLUM_WORKSPACE_DIR = WS_DIR;

    const resolved = resolveIpcSocketPath("example-service");

    expect(resolved.source).toBe("env-override");
    expect(resolved.path).toBe("/run/example-ipc/example-service.sock");

    delete process.env.EXAMPLE_SERVICE_IPC_SOCKET_DIR;
  });

  test.skipIf(process.platform !== "win32")(
    "rejects an occupied named pipe",
    async () => {
      const pipe = `\\\\.\\pipe\\vellum-ipc-test-${process.pid}`;
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(pipe, resolve);
      });
      try {
        await expect(ensureSocketPathFree(pipe)).rejects.toMatchObject({
          code: "EADDRINUSE",
        });
      } finally {
        server.close();
      }
    },
  );
});
