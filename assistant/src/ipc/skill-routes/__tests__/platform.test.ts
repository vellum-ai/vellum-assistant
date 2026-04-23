/**
 * Unit tests for the `host.platform.*` skill IPC routes. Mocks the platform
 * path helpers and runtime-mode resolver so route behavior is verified
 * independently of the real filesystem or `IS_CONTAINERIZED` env setting.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { DaemonRuntimeMode } from "../../../runtime/runtime-mode.js";

// ---------------------------------------------------------------------------
// Mock platform + runtime-mode helpers
// ---------------------------------------------------------------------------

let mockWorkspaceDir = "/tmp/workspace";
let mockVellumRoot = "/tmp/.vellum";
let mockRuntimeMode: DaemonRuntimeMode = "bare-metal";

mock.module("../../../util/platform.js", () => ({
  getWorkspaceDir: () => mockWorkspaceDir,
  vellumRoot: () => mockVellumRoot,
}));

mock.module("../../../runtime/runtime-mode.js", () => ({
  getDaemonRuntimeMode: () => mockRuntimeMode,
}));

const {
  hostPlatformWorkspaceDirRoute,
  hostPlatformVellumRootRoute,
  hostPlatformRuntimeModeRoute,
  platformRoutes,
} = await import("../platform.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockWorkspaceDir = "/tmp/workspace";
  mockVellumRoot = "/tmp/.vellum";
  mockRuntimeMode = "bare-metal";
});

afterEach(() => {
  mockWorkspaceDir = "/tmp/workspace";
  mockVellumRoot = "/tmp/.vellum";
  mockRuntimeMode = "bare-metal";
});

describe("host.platform.workspaceDir IPC route", () => {
  test("method is host.platform.workspaceDir", () => {
    expect(hostPlatformWorkspaceDirRoute.method).toBe(
      "host.platform.workspaceDir",
    );
  });

  test("returns the workspace directory from the platform helper", async () => {
    mockWorkspaceDir = "/Users/alice/.vellum/workspace";

    const result = await hostPlatformWorkspaceDirRoute.handler();

    expect(result).toBe("/Users/alice/.vellum/workspace");
  });
});

describe("host.platform.vellumRoot IPC route", () => {
  test("method is host.platform.vellumRoot", () => {
    expect(hostPlatformVellumRootRoute.method).toBe("host.platform.vellumRoot");
  });

  test("returns the vellum root from the platform helper", async () => {
    mockVellumRoot = "/Users/alice/.vellum";

    const result = await hostPlatformVellumRootRoute.handler();

    expect(result).toBe("/Users/alice/.vellum");
  });
});

describe("host.platform.runtimeMode IPC route", () => {
  test("method is host.platform.runtimeMode", () => {
    expect(hostPlatformRuntimeModeRoute.method).toBe(
      "host.platform.runtimeMode",
    );
  });

  test("returns 'bare-metal' when the daemon runs outside a container", async () => {
    mockRuntimeMode = "bare-metal";

    const result = await hostPlatformRuntimeModeRoute.handler();

    expect(result).toBe("bare-metal");
  });

  test("returns 'docker' when the daemon runs inside a container", async () => {
    mockRuntimeMode = "docker";

    const result = await hostPlatformRuntimeModeRoute.handler();

    expect(result).toBe("docker");
  });
});

describe("platformRoutes", () => {
  test("exports all three platform routes", () => {
    expect(platformRoutes).toContain(hostPlatformWorkspaceDirRoute);
    expect(platformRoutes).toContain(hostPlatformVellumRootRoute);
    expect(platformRoutes).toContain(hostPlatformRuntimeModeRoute);
  });
});
