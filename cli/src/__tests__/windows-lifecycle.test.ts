import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  executableName,
  isProcessAlive,
  isVellumCommandLine,
  isVellumWindowsProcess,
  pathListDelimiter,
  parseTasklistCsv,
  stopProcess,
  stopProcessByPidFile,
  windowsCommandLineLookupArgs,
} from "../lib/process";
import {
  isInteractiveCliSession,
  parseRemotePs,
  processTableCommand,
} from "../lib/orphan-detection";

test("uses Windows executable suffixes without changing Unix names", () => {
  expect(executableName("vellum-daemon", "win32")).toBe("vellum-daemon.exe");
  expect(executableName("vellum.exe", "win32")).toBe("vellum.exe");
  expect(executableName("vellum-daemon", "darwin")).toBe("vellum-daemon");
  expect(pathListDelimiter("win32")).toBe(";");
  expect(pathListDelimiter("linux")).toBe(":");
});

test("parses tasklist rows and ignores informational output", () => {
  const output =
    '"vellum-daemon.exe","4812","Console","1","20,000 K"\r\nINFO: No tasks match.';
  expect(parseTasklistCsv(output)).toEqual([
    { imageName: "vellum-daemon.exe", pid: 4812 },
  ]);
});

test("passes the PID inside the PowerShell command", () => {
  const args = windowsCommandLineLookupArgs(4812);
  expect(args).toHaveLength(4);
  expect(args[3]).toContain("ProcessId = 4812");
  expect(args[3]).not.toContain("$args");
});

test("selects a direct process-table command with fixed arguments", () => {
  const windows = processTableCommand("win32");
  expect(windows.command).toBe("powershell.exe");
  expect(windows.args.join(" ")).toContain("Win32_Process");
  expect(processTableCommand("linux")).toEqual({
    command: "ps",
    args: ["ax", "-o", "pid=,ppid=,args="],
  });
});

test("preserves command lines containing spaces and Unicode usernames", () => {
  const [parsed] = parseRemotePs(
    "42 1 C:\\Users\\Example User 用户\\Vellum\\vellum-daemon.exe --port 3030",
  );
  expect(parsed.command).toContain(
    "Example User 用户\\Vellum\\vellum-daemon.exe",
  );
  expect(
    isInteractiveCliSession(
      '"C:\\Users\\Example User 用户\\Vellum\\vellum.exe" exec -it --service vellum-gateway',
    ),
  ).toBeTrue();
});

test("rejects a stale PID file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vellum stale pid "));
  const pidFile = path.join(dir, "assistant.pid");
  writeFileSync(pidFile, "2147483647\n", "utf8");
  expect(isProcessAlive(pidFile)).toEqual({ alive: false, pid: null });
  rmSync(dir, { recursive: true, force: true });
});

test("recognizes only Vellum Bun-hosted process command lines", () => {
  expect(
    isVellumCommandLine(
      "bun.exe C:\\Users\\Example User 用户\\.vellum\\runtime\\assistant\\src\\daemon\\main.ts",
    ),
  ).toBeTrue();
  expect(
    isVellumCommandLine("bun.exe C:\\work\\unrelated\\server.ts"),
  ).toBeFalse();
});

test("verifies Windows Qdrant ownership from its command line", () => {
  expect(
    isVellumWindowsProcess(
      "qdrant.exe",
      "C:\\Users\\Example User\\.vellum\\workspace\\data\\qdrant\\bin\\qdrant.exe",
    ),
  ).toBeTrue();
  expect(
    isVellumWindowsProcess("qdrant.exe", "C:\\Databases\\qdrant.exe"),
  ).toBeFalse();
});

test("reports a failed forced Windows process-tree termination", async () => {
  const calls: string[][] = [];
  const stopped = await stopProcess(
    process.pid,
    "test process",
    0,
    "win32",
    (args) => {
      calls.push(args);
      throw new Error("access denied");
    },
  );

  expect(stopped).toBeFalse();
  expect(calls).toEqual([
    ["/PID", String(process.pid), "/T"],
    ["/PID", String(process.pid), "/T", "/F"],
  ]);
});

test("treats a Unix exit before SIGKILL as a successful stop", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const originalKill = process.kill.bind(process);
  process.kill = ((_pid: number, signal?: NodeJS.Signals | number) => {
    signals.push(signal);
    if (signal === "SIGKILL") {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    }
    return true;
  }) as typeof process.kill;

  try {
    expect(await stopProcess(4812, "test process", 0, "darwin")).toBeTrue();
    expect(signals).toEqual([0, "SIGTERM", 0, "SIGKILL"]);
  } finally {
    process.kill = originalKill;
  }
});

test("preserves PID tracking when process termination fails", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vellum live pid "));
  const pidFile = path.join(dir, "assistant.pid");
  writeFileSync(pidFile, `${process.pid}\n`, "utf8");

  expect(
    await stopProcessByPidFile(
      pidFile,
      "test process",
      undefined,
      0,
      async () => false,
      () => true,
    ),
  ).toBeFalse();
  expect(isProcessAlive(pidFile)).toEqual({ alive: true, pid: process.pid });
  rmSync(dir, { recursive: true, force: true });
});
