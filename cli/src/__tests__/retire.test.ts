import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantEntry } from "../lib/assistant-config.js";
import { loadAllAssistants } from "../lib/assistant-config.js";
import * as retireLocalModule from "../lib/retire-local.js";

const testDir = mkdtempSync(join(tmpdir(), "cli-retire-test-"));
const originalArgv = [...process.argv];
const originalExit = process.exit;
const originalLockfileDir = process.env.VELLUM_LOCKFILE_DIR;
const originalStdinIsTTY = process.stdin.isTTY;
const originalStdoutIsTTY = process.stdout.isTTY;
const originalStdinIsRaw = process.stdin.isRaw;
const originalSetRawMode = process.stdin.setRawMode;
const originalStdoutWrite = process.stdout.write;
const realRetireLocalModule = { ...retireLocalModule };

const retireLocalMock = mock(async () => {});

mock.module("../lib/retire-local.js", () => ({
  ...realRetireLocalModule,
  retireLocal: retireLocalMock,
}));

import { retire } from "../commands/retire.js";

let consoleLogSpy: ReturnType<typeof spyOn>;
let consoleErrorSpy: ReturnType<typeof spyOn>;

function makeEntry(
  assistantId: string,
  extra: Partial<AssistantEntry> = {},
): AssistantEntry {
  return {
    assistantId,
    runtimeUrl: `http://127.0.0.1:${7800 + assistantId.length}`,
    cloud: "local",
    resources: {
      instanceDir: join(testDir, assistantId),
      daemonPort: 7801,
      gatewayPort: 7831,
      qdrantPort: 6334,
      cesPort: 7790,
    },
    ...extra,
  };
}

function writeLockfile(entries: AssistantEntry[]): void {
  mkdirSync(testDir, { recursive: true });
  writeFileSync(
    join(testDir, ".vellum.lock.json"),
    JSON.stringify({ assistants: entries }, null, 2) + "\n",
  );
}

function readLockfile(): string {
  return readFileSync(join(testDir, ".vellum.lock.json"), "utf-8");
}

function setTerminalMode(isTTY: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: isTTY,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: isTTY,
  });
}

function setInteractiveTerminal(): void {
  setTerminalMode(true);
  Object.defineProperty(process.stdin, "isRaw", {
    configurable: true,
    value: false,
  });
  Object.defineProperty(process.stdin, "setRawMode", {
    configurable: true,
    value: mock(() => process.stdin),
  });
  process.stdout.write = (() => true) as typeof process.stdout.write;
}

function restoreTerminal(): void {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: originalStdinIsTTY,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: originalStdoutIsTTY,
  });
  Object.defineProperty(process.stdin, "isRaw", {
    configurable: true,
    value: originalStdinIsRaw,
  });
  Object.defineProperty(process.stdin, "setRawMode", {
    configurable: true,
    value: originalSetRawMode,
  });
  process.stdout.write = originalStdoutWrite;
}

describe("vellum retire", () => {
  beforeEach(() => {
    process.env.VELLUM_LOCKFILE_DIR = testDir;
    rmSync(join(testDir, ".vellum.lock.json"), { force: true });
    process.argv = ["bun", "vellum", "retire"];
    process.exit = ((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit;
    retireLocalMock.mockReset();
    retireLocalMock.mockResolvedValue(undefined);
    setTerminalMode(false);
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    restoreTerminal();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  afterAll(() => {
    mock.module("../lib/retire-local.js", () => realRetireLocalModule);
    if (originalLockfileDir === undefined) {
      delete process.env.VELLUM_LOCKFILE_DIR;
    } else {
      process.env.VELLUM_LOCKFILE_DIR = originalLockfileDir;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  test("--yes retires by unquoted display name and removes by assistant ID", async () => {
    const entry = makeEntry("assistant-1", { name: "Example Assistant" });
    writeLockfile([entry]);
    process.argv = ["bun", "vellum", "retire", "Example", "Assistant", "--yes"];

    await retire();

    expect(retireLocalMock).toHaveBeenCalledWith("assistant-1", entry);
    expect(loadAllAssistants()).toEqual([]);
    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Name: Example Assistant");
    expect(output).toContain("ID: assistant-1");
    expect(output).toContain(
      "Removed Example Assistant (assistant-1) from config.",
    );
  });

  test("non-interactive retire without --yes fails before deleting", async () => {
    const entry = makeEntry("assistant-1", { name: "Example Assistant" });
    writeLockfile([entry]);
    const before = readLockfile();
    process.argv = ["bun", "vellum", "retire", "Example", "Assistant"];

    await expect(retire()).rejects.toThrow("process.exit:1");

    expect(retireLocalMock).not.toHaveBeenCalled();
    expect(readLockfile()).toBe(before);
    const output = consoleErrorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Refusing to retire without confirmation");
    expect(output).toContain("--yes");
  });

  test("interactive cancel leaves the assistant untouched", async () => {
    const entry = makeEntry("assistant-1", { name: "Example Assistant" });
    writeLockfile([entry]);
    const before = readLockfile();
    setInteractiveTerminal();
    process.argv = ["bun", "vellum", "retire", "Example", "Assistant"];

    const pending = retire();
    queueMicrotask(() => {
      process.stdin.emit("data", Buffer.from("q"));
    });

    await expect(pending).rejects.toThrow("process.exit:1");
    expect(retireLocalMock).not.toHaveBeenCalled();
    expect(readLockfile()).toBe(before);
    expect(consoleLogSpy.mock.calls.flat().join("\n")).toContain(
      "Retire cancelled.",
    );
  });

  test("interactive confirmation retires the assistant", async () => {
    const entry = makeEntry("assistant-1", { name: "Example Assistant" });
    writeLockfile([entry]);
    setInteractiveTerminal();
    process.argv = ["bun", "vellum", "retire", "Example", "Assistant"];

    const pending = retire();
    queueMicrotask(() => {
      process.stdin.emit("data", Buffer.from([13]));
    });

    await pending;
    expect(retireLocalMock).toHaveBeenCalledWith("assistant-1", entry);
    expect(loadAllAssistants()).toEqual([]);
  });

  test("ambiguous display names fail before deleting", async () => {
    writeLockfile([
      makeEntry("assistant-1", { name: "Example Assistant" }),
      makeEntry("assistant-2", { name: "Example Assistant" }),
    ]);
    const before = readLockfile();
    process.argv = ["bun", "vellum", "retire", "Example", "Assistant", "--yes"];

    await expect(retire()).rejects.toThrow("process.exit:1");

    expect(retireLocalMock).not.toHaveBeenCalled();
    expect(readLockfile()).toBe(before);
    const output = consoleErrorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Multiple assistants match 'Example Assistant'");
    expect(output).toContain("assistant-1");
    expect(output).toContain("assistant-2");
  });
});
