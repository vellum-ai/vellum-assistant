import * as realChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../__tests__/helpers/set-config.js";
import { SHELL_DID_NOT_START_MESSAGE } from "../shared/shell-output.js";
import type { ToolContext } from "../types.js";

const originalSpawn = realChildProcess.spawn;

type FakeChild = EventEmitter & {
  pid?: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => boolean;
};

type SpawnImpl = (
  ...args: Parameters<typeof realChildProcess.spawn>
) => ReturnType<typeof realChildProcess.spawn>;

const spawnCalls: {
  command: string;
  args: unknown;
  options: realChildProcess.SpawnOptions;
}[] = [];

let spawnImpl: SpawnImpl = originalSpawn as SpawnImpl;

const spawnSpy = mock((...args: Parameters<typeof realChildProcess.spawn>) => {
  spawnCalls.push({
    command: args[0] as string,
    args: args[1],
    options: (args[2] ?? {}) as realChildProcess.SpawnOptions,
  });
  return spawnImpl(...args);
});

mock.module("node:child_process", () => ({
  ...realChildProcess,
  spawn: spawnSpy,
}));

const realLogger = await import("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

setConfig("timeouts", { shellDefaultTimeoutSec: 30, shellMaxTimeoutSec: 60 });

const realHub = await import("../../runtime/assistant-event-hub.js");
mock.module("../../runtime/assistant-event-hub.js", () => ({
  ...realHub,
  broadcastMessage: () => {},
}));

const realWake = await import("../../runtime/agent-wake.js");
mock.module("../../runtime/agent-wake.js", () => ({
  ...realWake,
  wakeAgentForOpportunity: async () => ({}),
}));

const { shellTool } = await import("./shell.js");

function makeContext(workingDir: string): ToolContext {
  return {
    workingDir,
    conversationId: "conv-xyz",
    trustClass: "guardian",
  };
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

function closeWithoutStart(): ReturnType<typeof realChildProcess.spawn> {
  const child = fakeChild();
  queueMicrotask(() => {
    child.emit("close", 0, null);
  });
  return child as unknown as ReturnType<typeof realChildProcess.spawn>;
}

function spawnError(
  err: NodeJS.ErrnoException,
): ReturnType<typeof realChildProcess.spawn> {
  const child = fakeChild();
  queueMicrotask(() => {
    child.emit("error", err);
  });
  return child as unknown as ReturnType<typeof realChildProcess.spawn>;
}

describe("bash launch failures are not success", () => {
  let workingDir = "";

  beforeEach(() => {
    spawnCalls.length = 0;
    spawnImpl = originalSpawn as SpawnImpl;
    workingDir = mkdtempSync(join(tmpdir(), "bash-launch-"));
  });

  afterEach(() => {
    spawnImpl = originalSpawn as SpawnImpl;
    rmSync(workingDir, { recursive: true, force: true });
  });

  test("a close with exit 0 and no process start is an error, not command_completed", async () => {
    spawnImpl = () => closeWithoutStart();
    const proof = join(workingDir, "proof.txt");

    const result = await shellTool.execute(
      {
        command: "printf ran > proof.txt",
        activity: "test",
      },
      makeContext(workingDir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe(SHELL_DID_NOT_START_MESSAGE);
    expect(result.content).not.toContain("<command_completed />");
    expect(existsSync(proof)).toBe(false);
    expect(spawnCalls).toHaveLength(1);
  });

  test("a failed spawn of the shell is an error", async () => {
    spawnImpl = () => {
      const err = new Error(
        "spawn powershell.exe ENOENT",
      ) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return spawnError(err);
    };

    const result = await shellTool.execute(
      {
        command: "assistant browser --help",
        activity: "test",
      },
      makeContext(workingDir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error spawning command");
    expect(result.content).toContain("The command was not found");
    expect(result.content).not.toContain("<command_completed />");
    expect(existsSync(join(workingDir, "help.txt"))).toBe(false);
  });
});
