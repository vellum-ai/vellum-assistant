import { tmpdir } from "node:os";
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
  test("uses env var override when set", () => {
    process.env.GATEWAY_IPC_SOCKET_DIR = "/run/gateway-ipc";
    process.env.VELLUM_WORKSPACE_DIR = "/tmp/vellum-workspace-test";

    const resolved = resolveIpcSocketPath("gateway");

    expect(resolved.source).toBe("env-override");
    expect(resolved.path).toBe("/run/gateway-ipc/gateway.sock");
  });

  test("ignores empty env var override", () => {
    process.env.GATEWAY_IPC_SOCKET_DIR = "  ";
    process.env.VELLUM_WORKSPACE_DIR = "/tmp/vellum-workspace-test";

    const resolved = resolveIpcSocketPath("gateway");

    expect(resolved.source).toBe("workspace");
    expect(resolved.path).toBe("/tmp/vellum-workspace-test/gateway.sock");
  });

  test("uses workspace path by default", () => {
    delete process.env.GATEWAY_IPC_SOCKET_DIR;
    process.env.VELLUM_WORKSPACE_DIR = "/tmp/vellum-workspace-test";

    const resolved = resolveIpcSocketPath("gateway");

    expect(resolved.source).toBe("workspace");
    expect(resolved.path).toBe("/tmp/vellum-workspace-test/gateway.sock");
  });

  test("falls back to tmpdir when workspace path exceeds AF_UNIX limit", () => {
    delete process.env.GATEWAY_IPC_SOCKET_DIR;
    // 90-char workspace dir + /gateway.sock = well over 103 bytes
    process.env.VELLUM_WORKSPACE_DIR = "/tmp/" + "a".repeat(85) + "/workspace";

    const resolved = resolveIpcSocketPath("gateway");

    expect(["tmp-hash", "tmp-short-hash"]).toContain(resolved.source);
    expect(resolved.path.startsWith(tmpdir())).toBe(true);
  });

  test("derives env var name from socket name", () => {
    process.env.ASSISTANT_SKILL_IPC_SOCKET_DIR = "/run/skill-ipc";
    process.env.VELLUM_WORKSPACE_DIR = "/tmp/vellum-workspace-test";

    const resolved = resolveIpcSocketPath("assistant-skill");

    expect(resolved.source).toBe("env-override");
    expect(resolved.path).toBe("/run/skill-ipc/assistant-skill.sock");

    delete process.env.ASSISTANT_SKILL_IPC_SOCKET_DIR;
  });
});
