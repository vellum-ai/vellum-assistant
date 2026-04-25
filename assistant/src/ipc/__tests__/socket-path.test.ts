import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveIpcSocketPath } from "../socket-path.js";

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
  test("uses GATEWAY_IPC_SOCKET_DIR when set", () => {
    process.env.GATEWAY_IPC_SOCKET_DIR = "/run/gateway-ipc";
    process.env.VELLUM_WORKSPACE_DIR = "/tmp/vellum-workspace-test";

    const resolved = resolveIpcSocketPath("assistant.sock");

    expect(resolved).toBe("/run/gateway-ipc/assistant.sock");
  });

  test("ignores empty GATEWAY_IPC_SOCKET_DIR", () => {
    process.env.GATEWAY_IPC_SOCKET_DIR = "  ";
    process.env.VELLUM_WORKSPACE_DIR = "/tmp/vellum-workspace-test";

    const resolved = resolveIpcSocketPath("assistant.sock");

    expect(resolved).toBe("/tmp/vellum-workspace-test/assistant.sock");
  });

  test("uses workspace path by default", () => {
    delete process.env.GATEWAY_IPC_SOCKET_DIR;
    process.env.VELLUM_WORKSPACE_DIR = "/tmp/vellum-workspace-test";

    const resolved = resolveIpcSocketPath("assistant.sock");

    expect(resolved).toBe("/tmp/vellum-workspace-test/assistant.sock");
  });

  test("accepts explicit workspaceDir parameter", () => {
    delete process.env.GATEWAY_IPC_SOCKET_DIR;

    const resolved = resolveIpcSocketPath(
      "assistant.sock",
      "/custom/workspace",
    );

    expect(resolved).toBe("/custom/workspace/assistant.sock");
  });
});
