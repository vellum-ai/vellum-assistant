import * as realChildProcess from "node:child_process";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { isLinux, isMacOS } from "../util/platform.js";

const execSyncMock = mock(
  (_command: string, _opts?: unknown): unknown => undefined,
);

mock.module("node:child_process", () => ({
  ...realChildProcess,
  execSync: execSyncMock,
}));

// Mock config loader — return a config with sandbox settings
let mockSandboxConfig: {
  enabled: boolean;
} = {
  enabled: true,
};

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    sandbox: mockSandboxConfig,
  }),
  loadRawConfig: () => ({}),
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  }),
}));

const { runSandboxDiagnostics } =
  await import("../tools/terminal/sandbox-diagnostics.js");

beforeEach(() => {
  execSyncMock.mockReset();
  mockSandboxConfig = {
    enabled: true,
  };
  // Default: all commands succeed.
  execSyncMock.mockImplementation(() => undefined);
});

describe("runSandboxDiagnostics — config reporting", () => {
  test("reports sandbox enabled state", () => {
    const result = runSandboxDiagnostics();
    expect(result.config.enabled).toBe(true);
  });

  test("reports sandbox disabled state", () => {
    mockSandboxConfig.enabled = false;
    const result = runSandboxDiagnostics();
    expect(result.config.enabled).toBe(false);
  });
});

describe("runSandboxDiagnostics — active backend reason", () => {
  test("explains native backend selection", () => {
    const result = runSandboxDiagnostics();
    expect(result.activeBackendReason).toContain("Native backend");
  });

  test("explains when sandbox is disabled", () => {
    mockSandboxConfig.enabled = false;
    const result = runSandboxDiagnostics();
    expect(result.activeBackendReason).toContain("disabled");
  });
});

describe("runSandboxDiagnostics — native backend check", () => {
  test("passes when native sandbox command succeeds", () => {
    const result = runSandboxDiagnostics();
    const nativeCheck = result.checks.find((c) =>
      c.label.includes("Native sandbox"),
    );
    expect(nativeCheck).toBeDefined();
    expect(nativeCheck!.ok).toBe(true);
    // Verify the label matches the real platform
    if (isMacOS()) {
      expect(nativeCheck!.label).toContain("macOS");
    } else if (isLinux()) {
      expect(nativeCheck!.label).toContain("Linux");
    }
  });

  test("fails when native sandbox command does not work", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("not available");
    });
    const result = runSandboxDiagnostics();
    const nativeCheck = result.checks.find((c) =>
      c.label.includes("Native sandbox"),
    );
    expect(nativeCheck).toBeDefined();
    expect(nativeCheck!.ok).toBe(false);
  });
});

describe("runSandboxDiagnostics — only native checks", () => {
  test("only includes native backend check", () => {
    const result = runSandboxDiagnostics();
    const labels = result.checks.map((c) => c.label);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain("Native sandbox");
  });
});
