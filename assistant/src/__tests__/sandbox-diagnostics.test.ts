import * as realChildProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const execSyncMock = mock(
  (_command: string, _opts?: unknown): unknown => undefined,
);

mock.module("node:child_process", () => ({
  ...realChildProcess,
  execSync: execSyncMock,
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

// ---------------------------------------------------------------------------
// Helper: temporarily override process.platform for a test
// ---------------------------------------------------------------------------
const originalPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform });
}

beforeEach(() => {
  execSyncMock.mockReset();
  // Default: all commands succeed.
  execSyncMock.mockImplementation(() => undefined);
});

afterEach(() => {
  // Restore the real platform after every test
  setPlatform(originalPlatform);
});

describe("runSandboxDiagnostics — config reporting", () => {
  test("reports sandbox disabled (sandbox removed)", () => {
    const result = runSandboxDiagnostics();
    expect(result.config.enabled).toBe(false);
  });
});

describe("runSandboxDiagnostics — active backend reason", () => {
  test("explains when sandbox is disabled", () => {
    const result = runSandboxDiagnostics();
    expect(result.activeBackendReason).toContain("disabled");
  });
});

describe("runSandboxDiagnostics — native backend check (macOS)", () => {
  test("passes when sandbox-exec works on macOS", () => {
    setPlatform("darwin");
    const result = runSandboxDiagnostics();
    const nativeCheck = result.checks.find((c) =>
      c.label.includes("Native sandbox"),
    );
    expect(nativeCheck).toBeDefined();
    expect(nativeCheck!.ok).toBe(true);
    expect(nativeCheck!.label).toContain("macOS");
  });

  test("fails when sandbox-exec does not work on macOS", () => {
    setPlatform("darwin");
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
    setPlatform("linux");
    const result = runSandboxDiagnostics();
    const nativeCheck = result.checks.find((c) =>
      c.label.includes("Native sandbox"),
    );
    expect(nativeCheck).toBeDefined();
    expect(nativeCheck!.ok).toBe(true);
    expect(nativeCheck!.label).toContain("Linux");
  });

  test("fails when bwrap is not available on Linux", () => {
    setPlatform("linux");
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
    setPlatform("win32");
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
