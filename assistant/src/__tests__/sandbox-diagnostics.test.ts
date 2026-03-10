import * as realChildProcess from "node:child_process";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const execSyncMock = mock(
  (_command: string, _opts?: unknown): unknown => undefined,
);

mock.module("node:child_process", () => ({
  ...realChildProcess,
  execSync: execSyncMock,
}));

// Mock platform detection — default to macOS
let mockIsMacOS = true;
let mockIsLinux = false;

mock.module("../util/platform.js", () => ({
  isMacOS: () => mockIsMacOS,
  isLinux: () => mockIsLinux,
  getRootDir: () => "/tmp/vellum-test",
  getDataDir: () => "/tmp/vellum-test/data",
  getDbPath: () => "/tmp/vellum-test/data/db/assistant.db",
  getLogPath: () => "/tmp/vellum-test/data/logs/daemon.log",
  getSandboxRootDir: () => "/tmp/vellum-test/sandbox",
  getSandboxWorkingDir: () => "/tmp/vellum-test/workspace",
  ensureDataDir: () => {},
  getHistoryPath: () => "/tmp/vellum-test/data/history",
  getHooksDir: () => "/tmp/vellum-test/hooks",
  getPidPath: () => "/tmp/vellum-test/data/daemon.pid",
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
  mockIsMacOS = true;
  mockIsLinux = false;
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

describe("runSandboxDiagnostics — native backend check (macOS)", () => {
  test("passes when sandbox-exec works on macOS", () => {
    const result = runSandboxDiagnostics();
    const nativeCheck = result.checks.find((c) =>
      c.label.includes("Native sandbox"),
    );
    expect(nativeCheck).toBeDefined();
    expect(nativeCheck!.ok).toBe(true);
    expect(nativeCheck!.label).toContain("macOS");
  });

  test("fails when sandbox-exec does not work on macOS", () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("sandbox-exec")) {
        throw new Error("not available");
      }
      return "Docker version 24.0.7";
    });
    const result = runSandboxDiagnostics();
    const nativeCheck = result.checks.find((c) =>
      c.label.includes("Native sandbox"),
    );
    expect(nativeCheck).toBeDefined();
    expect(nativeCheck!.ok).toBe(false);
  });
});

describe("runSandboxDiagnostics — native backend check (Linux)", () => {
  test("passes when bwrap works on Linux", () => {
    mockIsMacOS = false;
    mockIsLinux = true;
    const result = runSandboxDiagnostics();
    const nativeCheck = result.checks.find((c) =>
      c.label.includes("Native sandbox"),
    );
    expect(nativeCheck).toBeDefined();
    expect(nativeCheck!.ok).toBe(true);
    expect(nativeCheck!.label).toContain("Linux");
  });

  test("fails when bwrap is not available on Linux", () => {
    mockIsMacOS = false;
    mockIsLinux = true;
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("bwrap")) {
        throw new Error("not found");
      }
      return "Docker version 24.0.7";
    });
    const result = runSandboxDiagnostics();
    const nativeCheck = result.checks.find((c) =>
      c.label.includes("Native sandbox"),
    );
    expect(nativeCheck).toBeDefined();
    expect(nativeCheck!.ok).toBe(false);
    expect(nativeCheck!.detail).toContain("bubblewrap");
  });
});

describe("runSandboxDiagnostics — native backend check (unsupported OS)", () => {
  test("reports unsupported when neither macOS nor Linux", () => {
    mockIsMacOS = false;
    mockIsLinux = false;
    const result = runSandboxDiagnostics();
    const nativeCheck = result.checks.find((c) =>
      c.label.includes("Native sandbox"),
    );
    expect(nativeCheck).toBeDefined();
    expect(nativeCheck!.ok).toBe(false);
    expect(nativeCheck!.detail).toContain("not supported");
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
