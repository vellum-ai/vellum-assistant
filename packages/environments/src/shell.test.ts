import { describe, expect, test } from "bun:test";

import {
  buildShellInvocation,
  buildShellSpawnFlags,
  CHILD_OOM_SCORE_ADJ,
  pathListDelimiter,
  prependUniquePathEntries,
} from "./shell.js";

describe("buildShellInvocation", () => {
  test("uses Bash on POSIX hosts", () => {
    expect(buildShellInvocation("printf hello", "darwin")).toEqual({
      command: "bash",
      args: ["-c", "--", "printf hello"],
    });
  });

  test("raises the shell's OOM-kill priority on Linux", () => {
    expect(buildShellInvocation("printf hello", "linux")).toEqual({
      command: "bash",
      args: [
        "-c",
        "--",
        `echo ${CHILD_OOM_SCORE_ADJ} 2>/dev/null >/proc/self/oom_score_adj; printf hello`,
      ],
    });
  });

  test("uses encoded non-interactive PowerShell on Windows", () => {
    const invocation = buildShellInvocation(
      "Write-Output 'hello 世界'",
      "win32",
    );

    expect(invocation.command).toBe("powershell.exe");
    expect(invocation.args.slice(0, -1)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
    ]);
    const encoded = invocation.args.at(-1)!;
    const decoded = Buffer.from(encoded, "base64").toString("utf16le");
    expect(decoded).toContain("[Console]::OutputEncoding");
    expect(decoded).toContain("$global:LASTEXITCODE = 0");
    expect(decoded).toContain("Write-Output 'hello 世界'");
    expect(decoded).toContain("exit $__vellumNativeExitCode");
    expect(decoded).toEndWith("exit 0");
  });
});

describe("buildShellSpawnFlags", () => {
  test("creates a POSIX process group and hides Windows consoles", () => {
    expect(buildShellSpawnFlags("linux")).toEqual({
      detached: true,
      windowsHide: true,
    });
    expect(buildShellSpawnFlags("darwin")).toEqual({
      detached: true,
      windowsHide: true,
    });
  });

  test("does not detach Windows children that use piped stdio", () => {
    expect(buildShellSpawnFlags("win32")).toEqual({
      detached: false,
      windowsHide: true,
    });
  });
});

describe("path list handling", () => {
  test("uses the platform delimiter", () => {
    expect(pathListDelimiter("win32")).toBe(";");
    expect(pathListDelimiter("linux")).toBe(":");
  });

  test("prepends Windows paths without splitting drive letters", () => {
    expect(
      prependUniquePathEntries(
        "C:\\Windows\\System32;C:\\Tools",
        ["C:\\Tools", "C:\\Users\\Alice\\.bun\\bin"],
        "win32",
      ),
    ).toBe("C:\\Users\\Alice\\.bun\\bin;C:\\Windows\\System32;C:\\Tools");
  });
});
