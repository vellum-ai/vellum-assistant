import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveIpcSocketPath } from "../ipc/socket-path.js";

const LONG_WORKSPACE_DIR =
  "/Users/noaflaherty/.local/share/vellum-dev/assistants/vellum-safe-dace-8hrt6e/.vellum/workspace";

let savedWorkspaceDir: string | undefined;
let savedBaseDataDir: string | undefined;
let savedGatewayIpcSocketDir: string | undefined;

beforeEach(() => {
  savedWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  savedBaseDataDir = process.env.BASE_DATA_DIR;
  savedGatewayIpcSocketDir = process.env.GATEWAY_IPC_SOCKET_DIR;
});

afterEach(() => {
  if (savedWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = savedWorkspaceDir;
  }
  if (savedBaseDataDir === undefined) {
    delete process.env.BASE_DATA_DIR;
  } else {
    process.env.BASE_DATA_DIR = savedBaseDataDir;
  }
  if (savedGatewayIpcSocketDir === undefined) {
    delete process.env.GATEWAY_IPC_SOCKET_DIR;
  } else {
    process.env.GATEWAY_IPC_SOCKET_DIR = savedGatewayIpcSocketDir;
  }
});

describe("resolveIpcSocketPath", () => {
  test("uses GATEWAY_IPC_SOCKET_DIR when set", () => {
    process.env.GATEWAY_IPC_SOCKET_DIR = "/run/gateway-ipc";
    process.env.VELLUM_WORKSPACE_DIR = "/tmp/vellum-workspace-test";

    const resolved = resolveIpcSocketPath("gateway.sock");

    expect(resolved.source).toBe("env-override");
    expect(resolved.path).toBe("/run/gateway-ipc/gateway.sock");
  });

  test("ignores empty GATEWAY_IPC_SOCKET_DIR", () => {
    process.env.GATEWAY_IPC_SOCKET_DIR = "  ";
    process.env.VELLUM_WORKSPACE_DIR = "/tmp/vellum-workspace-test";
    delete process.env.BASE_DATA_DIR;

    const resolved = resolveIpcSocketPath("gateway.sock");

    expect(resolved.source).toBe("workspace");
    expect(resolved.path).toBe("/tmp/vellum-workspace-test/gateway.sock");
  });

  test("uses workspace path when it is within the platform limit", () => {
    process.env.VELLUM_WORKSPACE_DIR = "/tmp/vellum-workspace-test";
    delete process.env.BASE_DATA_DIR;

    const resolved = resolveIpcSocketPath("gateway.sock");

    expect(resolved.source).toBe("workspace");
    expect(resolved.path).toBe("/tmp/vellum-workspace-test/gateway.sock");
    expect(Buffer.byteLength(resolved.path, "utf8")).toBeLessThanOrEqual(
      resolved.maxPathBytes,
    );
  });

  test("falls back to BASE_DATA_DIR/ipc when workspace path is too long", () => {
    process.env.VELLUM_WORKSPACE_DIR = LONG_WORKSPACE_DIR;
    process.env.BASE_DATA_DIR = "/tmp/vellum-instance-test";

    const resolved = resolveIpcSocketPath("gateway.sock");

    expect(resolved.source).toBe("base-data-dir");
    expect(resolved.path).toBe("/tmp/vellum-instance-test/ipc/gateway.sock");
    expect(Buffer.byteLength(resolved.path, "utf8")).toBeLessThanOrEqual(
      resolved.maxPathBytes,
    );
  });

  test("falls back to tmpdir hash path when workspace path is too long and BASE_DATA_DIR is absent", () => {
    process.env.VELLUM_WORKSPACE_DIR = LONG_WORKSPACE_DIR;
    delete process.env.BASE_DATA_DIR;

    const resolved = resolveIpcSocketPath("gateway.sock");

    expect(resolved.source).toBe("tmp-hash");
    expect(resolved.path.startsWith(join(tmpdir(), "vellum-ipc"))).toBe(true);
    expect(resolved.path.endsWith("gateway.sock")).toBe(true);
    expect(Buffer.byteLength(resolved.path, "utf8")).toBeLessThanOrEqual(
      resolved.maxPathBytes,
    );
  });
});
