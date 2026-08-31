import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import * as childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realChildProcess = { ...childProcess };

function makeFakeChild(pid: number): ChildProcess {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    stdout: null,
    stderr: null,
    killed: false,
    kill: () => true,
    unref: () => {},
    pid,
  }) as unknown as ChildProcess;
}

const spawnMock = mock((..._args: unknown[]) => makeFakeChild(1111));

beforeAll(() => {
  mock.module("node:child_process", () => ({
    ...realChildProcess,
    spawn: spawnMock,
  }));
});

afterAll(() => {
  mock.module("node:child_process", () => realChildProcess);
});

const { relaunchDetached } = await import("../lib/detached-process.js");

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const tempDirs: string[] = [];

describe("relaunchDetached", () => {
  beforeEach(() => {
    spawnMock.mockClear();
    const configHome = mkdtempSync(join(tmpdir(), "vellum-detached-xdg-"));
    tempDirs.push(configHome);
    process.env.XDG_CONFIG_HOME = configHome;
  });

  afterEach(() => {
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("spawns the current binary detached with the given args and reports readiness", async () => {
    spawnMock.mockImplementationOnce(() => makeFakeChild(2222));

    const result = await relaunchDetached({
      args: ["tunnel", "--provider", "ngrok"],
      logFile: "relaunch-ready.log",
      timeoutMs: 1000,
      pollIntervalMs: 10,
      isReady: () => true,
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(cmd).toBe(process.execPath);
    expect(args).toContain("tunnel");
    expect(args).toContain("--provider");
    expect(args).toContain("ngrok");
    expect(opts.detached).toBe(true);

    expect(result.ready).toBe(true);
    expect(result.exitCode).toBeUndefined();
    expect(result.child.pid).toBe(2222);
    expect(result.logPath.endsWith("relaunch-ready.log")).toBe(true);
  });

  test("passes the resolved log path into isReady", async () => {
    spawnMock.mockImplementationOnce(() => makeFakeChild(3333));
    const seenPaths: string[] = [];

    const result = await relaunchDetached({
      args: ["tunnel"],
      logFile: "relaunch-logpath.log",
      timeoutMs: 1000,
      pollIntervalMs: 10,
      isReady: (logPath) => {
        seenPaths.push(logPath);
        return true;
      },
    });

    expect(seenPaths).toEqual([result.logPath]);
  });

  test("stops polling and reports the exit code once the child exits before readiness", async () => {
    spawnMock.mockImplementationOnce(() => {
      const child = makeFakeChild(4444);
      // Listeners attach synchronously right after spawn() returns; defer the
      // exit so they're in place before it fires.
      setTimeout(() => (child as unknown as EventEmitter).emit("exit", 7), 0);
      return child;
    });

    const result = await relaunchDetached({
      args: ["tunnel"],
      logFile: "relaunch-exit.log",
      timeoutMs: 1000,
      pollIntervalMs: 10,
      isReady: () => false,
    });

    expect(result.ready).toBe(false);
    expect(result.exitCode).toBe(7);
  });

  test("gives up once timeoutMs elapses with no readiness and no exit", async () => {
    spawnMock.mockImplementationOnce(() => makeFakeChild(5555));

    const result = await relaunchDetached({
      args: ["tunnel"],
      logFile: "relaunch-timeout.log",
      timeoutMs: 60,
      pollIntervalMs: 10,
      isReady: () => false,
    });

    expect(result.ready).toBe(false);
    expect(result.exitCode).toBeUndefined();
    expect(result.child.pid).toBe(5555);
  });
});
