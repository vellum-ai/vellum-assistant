import * as realChildProcess from "node:child_process";
import * as realFs from "node:fs";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { SandboxConfig } from "../config/schema.js";

let platform = "linux";

const execSyncMock = mock((_command: string): unknown => {
  throw new Error("bwrap unavailable");
});

mock.module("../util/platform.js", () => ({
  isMacOS: () => platform === "darwin",
  isLinux: () => platform === "linux",
  getSandboxWorkingDir: () => "/tmp/sandbox/fs",
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  }),
}));

mock.module("node:child_process", () => ({
  ...realChildProcess,
  execSync: execSyncMock,
}));

const writeFileSyncMock = mock((..._args: unknown[]) => {});
const existsSyncMock = mock((_path: string) => true);
const mkdirSyncMock = mock((..._args: unknown[]) => {});

mock.module("node:fs", () => ({
  ...realFs,
  writeFileSync: writeFileSyncMock,
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
}));

const { wrapCommand } = await import("../tools/terminal/sandbox.js");
const { ToolError } = await import("../util/errors.js");

function disabledConfig(): SandboxConfig {
  return { enabled: false };
}

function nativeConfig(): SandboxConfig {
  return { enabled: true };
}

describe("terminal sandbox — disabled behavior", () => {
  beforeEach(() => {
    platform = "linux";
  });

  test("returns unsandboxed bash -c wrapper when disabled", () => {
    const result = wrapCommand("pwd", "/tmp", disabledConfig());
    expect(result).toEqual({
      command: "bash",
      args: ["-c", "--", "pwd"],
      sandboxed: false,
    });
  });

  test("sandboxed flag is false when disabled regardless of platform", () => {
    for (const p of ["linux", "darwin", "win32"]) {
      platform = p;
      const result = wrapCommand("echo hi", "/tmp", disabledConfig());
      expect(result.sandboxed).toBe(false);
      expect(result.command).toBe("bash");
    }
  });

  test("preserves the original command string in args when disabled", () => {
    const cmd = "cat /etc/passwd | wc -l";
    const result = wrapCommand(cmd, "/home/user", disabledConfig());
    expect(result.args).toEqual(["-c", "--", cmd]);
  });
});

describe("terminal sandbox — enabled fail-closed behavior", () => {
  beforeEach(() => {
    platform = "linux";
    execSyncMock.mockImplementation((_command: string) => {
      throw new Error("bwrap unavailable");
    });
  });

  test("throws ToolError when bwrap is unavailable on linux", () => {
    expect(() => wrapCommand("echo hello", "/tmp", nativeConfig())).toThrow(
      ToolError,
    );
    expect(() => wrapCommand("echo hello", "/tmp", nativeConfig())).toThrow(
      "Sandbox is enabled but bwrap is not available or cannot create namespaces.",
    );
  });

  test("returns bwrap wrapper when bwrap is available on linux", () => {
    // GIVEN bwrap is available on a linux platform
    execSyncMock.mockImplementation(() => undefined);

    // WHEN wrapping a command with the native sandbox config
    const result = wrapCommand(
      "echo hello",
      "/home/user/project",
      nativeConfig(),
    );

    // THEN the result uses bwrap with network isolation
    expect(result.command).toBe("bwrap");
    expect(result.sandboxed).toBe(true);
    expect(result.args).toContain("--ro-bind");
    expect(result.args).toContain("--unshare-net");
    expect(result.args).toContain("--unshare-pid");

    // AND the user command runs via bash inside the sandbox
    const bashIdx = result.args.indexOf("bash");
    expect(bashIdx).toBeGreaterThan(0);
    expect(result.args.slice(bashIdx)).toEqual([
      "bash",
      "-c",
      "--",
      "echo hello",
    ]);
  });

  test("bind-mounts working directory read-write in bwrap args", () => {
    execSyncMock.mockImplementation(() => undefined);
    const workDir = "/home/user/my-project";
    const result = wrapCommand("ls", workDir, nativeConfig());
    // The args should contain --bind workDir workDir for read-write access
    const bindIdx = result.args.indexOf("--bind");
    expect(bindIdx).toBeGreaterThan(-1);
    expect(result.args[bindIdx + 1]).toBe(workDir);
    expect(result.args[bindIdx + 2]).toBe(workDir);
  });
});

describe("terminal sandbox — unsupported platform fail-closed behavior", () => {
  test("throws ToolError on unsupported platforms when enabled", () => {
    platform = "win32";
    expect(() => wrapCommand("pwd", "/tmp", nativeConfig())).toThrow(ToolError);
    expect(() => wrapCommand("pwd", "/tmp", nativeConfig())).toThrow(
      "Sandbox is enabled but not supported on this platform (",
    );
  });

  test("error message includes refusing to execute unsandboxed", () => {
    platform = "win32";
    try {
      wrapCommand("pwd", "/tmp", nativeConfig());
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as Error).message).toContain(
        "Refusing to execute unsandboxed",
      );
    }
  });
});

describe("terminal sandbox — macOS sandbox-exec behavior", () => {
  beforeEach(() => {
    platform = "darwin";
    writeFileSyncMock.mockClear();
    existsSyncMock.mockImplementation(() => true);
  });

  test("returns sandbox-exec wrapper on macOS when enabled", () => {
    // GIVEN the platform is macOS
    // (set in beforeEach)

    // WHEN wrapping a command with the native sandbox config
    const result = wrapCommand("echo hello", "/tmp/project", nativeConfig());

    // THEN the result uses sandbox-exec
    expect(result.command).toBe("sandbox-exec");
    expect(result.sandboxed).toBe(true);
    expect(result.args[0]).toBe("-f");

    // AND the profile path is the second arg
    expect(result.args[1]).toContain("sandbox-profile-");

    // AND bash -c -- command follows the profile
    expect(result.args.slice(2)).toEqual(["bash", "-c", "--", "echo hello"]);
  });

  test("escapes SBPL metacharacters in working dirs instead of throwing", () => {
    // The sandbox now escapes metacharacters rather than rejecting them
    const result1 = wrapCommand("pwd", '/tmp/bad"dir', nativeConfig());
    expect(result1.sandboxed).toBe(true);
    const result2 = wrapCommand("pwd", "/tmp/bad(dir", nativeConfig());
    expect(result2.sandboxed).toBe(true);
    const result3 = wrapCommand("pwd", "/tmp/bad;dir", nativeConfig());
    expect(result3.sandboxed).toBe(true);
  });

  test("SBPL profile escapes metacharacters in working dir path", () => {
    // Verify the sandbox profile is written with escaped chars
    wrapCommand("pwd", '/tmp/bad"dir', nativeConfig());
    const profileContent = writeFileSyncMock.mock.calls[0]?.[1] as string;
    expect(profileContent).toContain('bad\\"dir');
  });

  test("SBPL profile allows writes to /dev/null", () => {
    wrapCommand("git status", "/tmp/project", nativeConfig());
    const profileContent = writeFileSyncMock.mock.calls[0]?.[1] as string;
    expect(profileContent).toContain('(literal "/dev/null")');
  });
});

describe("terminal sandbox — backend selection", () => {
  beforeEach(() => {
    platform = "darwin";
    writeFileSyncMock.mockClear();
    existsSyncMock.mockImplementation(() => true);
  });

  test('uses native backend when backend is "native"', () => {
    const result = wrapCommand("echo hello", "/tmp/project", nativeConfig());
    expect(result.command).toBe("sandbox-exec");
    expect(result.sandboxed).toBe(true);
  });

  test("disabled config returns unsandboxed wrapper", () => {
    const config: SandboxConfig = { enabled: false };
    const result = wrapCommand("echo hello", "/tmp/project", config);
    expect(result.command).toBe("bash");
    expect(result.sandboxed).toBe(false);
  });
});

describe("terminal sandbox — proxied network mode on Linux", () => {
  beforeEach(() => {
    platform = "linux";
    execSyncMock.mockImplementation(() => undefined);
  });

  test("omits --unshare-net when networkMode is proxied", () => {
    /**
     * Tests that bwrap args omit --unshare-net in proxied mode so the process
     * can reach the local credential proxy on 127.0.0.1.
     */

    // GIVEN bwrap is available on linux
    // (set in beforeEach)

    // WHEN wrapping a command with proxied network mode
    const result = wrapCommand(
      "curl https://example.com",
      "/home/user/project",
      nativeConfig(),
      { networkMode: "proxied" },
    );

    // THEN the result uses bwrap
    expect(result.command).toBe("bwrap");
    expect(result.sandboxed).toBe(true);

    // AND --unshare-net is NOT present (network is allowed)
    expect(result.args).not.toContain("--unshare-net");

    // AND --unshare-pid is still present (PID isolation remains)
    expect(result.args).toContain("--unshare-pid");
  });

  test("includes --unshare-net when networkMode is off", () => {
    /**
     * Tests that bwrap args include --unshare-net when network is off (default).
     */

    // GIVEN bwrap is available on linux
    // (set in beforeEach)

    // WHEN wrapping a command with network mode off
    const result = wrapCommand(
      "echo hello",
      "/home/user/project",
      nativeConfig(),
      { networkMode: "off" },
    );

    // THEN --unshare-net is present (network is blocked)
    expect(result.args).toContain("--unshare-net");
  });

  test("includes --unshare-net when no options are provided", () => {
    /**
     * Tests that the default behavior (no options) blocks network access.
     */

    // GIVEN bwrap is available on linux
    // (set in beforeEach)

    // WHEN wrapping a command without any options
    const result = wrapCommand(
      "echo hello",
      "/home/user/project",
      nativeConfig(),
    );

    // THEN --unshare-net is present (network is blocked by default)
    expect(result.args).toContain("--unshare-net");
  });
});

describe("terminal sandbox — proxied network mode on macOS", () => {
  beforeEach(() => {
    platform = "darwin";
    writeFileSyncMock.mockClear();
    existsSyncMock.mockImplementation(() => true);
  });

  test("writes SBPL profile with allow network when networkMode is proxied", () => {
    /**
     * Tests that the macOS sandbox profile allows network access in proxied mode
     * so the process can reach the local credential proxy.
     */

    // GIVEN the platform is macOS
    // (set in beforeEach)

    // WHEN wrapping a command with proxied network mode
    wrapCommand("curl https://example.com", "/tmp/project", nativeConfig(), {
      networkMode: "proxied",
    });

    // THEN the written profile contains (allow network*) instead of (deny network*)
    const profileContent = writeFileSyncMock.mock.calls[0]?.[1] as string;
    expect(profileContent).toContain("(allow network*)");
    expect(profileContent).not.toContain("(deny network*)");
  });

  test("writes SBPL profile with deny network when networkMode is off", () => {
    /**
     * Tests that the macOS sandbox profile blocks network access when network
     * mode is off (the default behavior).
     */

    // GIVEN the platform is macOS
    // (set in beforeEach)

    // WHEN wrapping a command with network mode off
    wrapCommand("echo hello", "/tmp/project", nativeConfig(), {
      networkMode: "off",
    });

    // THEN the written profile contains (deny network*)
    const profileContent = writeFileSyncMock.mock.calls[0]?.[1] as string;
    expect(profileContent).toContain("(deny network*)");
    expect(profileContent).not.toContain("(allow network*)");
  });

  test("writes SBPL profile with deny network when no options are provided", () => {
    /**
     * Tests that the default behavior (no options) blocks network access on macOS.
     */

    // GIVEN the platform is macOS
    // (set in beforeEach)

    // WHEN wrapping a command without any options
    wrapCommand("echo hello", "/tmp/project", nativeConfig());

    // THEN the written profile contains (deny network*)
    const profileContent = writeFileSyncMock.mock.calls[0]?.[1] as string;
    expect(profileContent).toContain("(deny network*)");
    expect(profileContent).not.toContain("(allow network*)");
  });
});
