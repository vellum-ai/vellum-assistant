/**
 * Unit tests for the xdotool-click primitive.
 *
 * We inject a fake `spawn` via `opts.spawn` so tests never actually exec
 * xdotool. The shape of the fake child mirrors the one used in
 * `chrome-launcher.test.ts`: an EventEmitter with `stderr`, `.kill()`, and
 * a `__simulateExit(code, signal?)` helper.
 */

import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";

import { xdotoolClick } from "../src/browser/xdotool-click.js";

interface SpawnCall {
  command: string;
  args: string[];
  options: { env?: NodeJS.ProcessEnv };
}

interface FakeChild extends EventEmitter {
  stderr: EventEmitter;
  kill: (signal?: NodeJS.Signals) => boolean;
  __killSignals: NodeJS.Signals[];
  __simulateExit: (code: number | null, signal?: NodeJS.Signals) => void;
  __simulateSpawnError: (err: Error) => void;
  __simulateStderr: (chunk: string) => void;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stderr = new EventEmitter();
  child.__killSignals = [];
  child.kill = (signal?: NodeJS.Signals): boolean => {
    child.__killSignals.push(signal ?? "SIGTERM");
    return true;
  };
  child.__simulateExit = (code, signal) => {
    child.emit("exit", code, signal ?? null);
  };
  child.__simulateSpawnError = (err) => {
    child.emit("error", err);
  };
  child.__simulateStderr = (chunk) => {
    child.stderr.emit("data", Buffer.from(chunk, "utf8"));
  };
  return child;
}

function makeFakeSpawn(fakeChild: FakeChild): {
  spawn: never;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const impl = (
    command: string,
    args: readonly string[],
    options: { env?: NodeJS.ProcessEnv },
  ) => {
    calls.push({ command, args: [...args], options });
    return fakeChild;
  };
  return { spawn: impl as unknown as never, calls };
}

describe("xdotoolClick", () => {
  test("spawns xdotool with mousemove+click args and DISPLAY env", async () => {
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);

    const pending = xdotoolClick({
      x: 120,
      y: 240,
      display: ":99",
      spawn: fake.spawn,
    });
    child.__simulateExit(0);
    await pending;

    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]!.command).toBe("/usr/bin/xdotool");
    expect(fake.calls[0]!.args).toEqual([
      "mousemove",
      "120",
      "240",
      "click",
      "1",
    ]);
    expect(fake.calls[0]!.options.env?.DISPLAY).toBe(":99");
  });

  test("honours custom binary override", async () => {
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);

    const pending = xdotoolClick({
      x: 0,
      y: 0,
      display: ":42",
      binary: "/custom/xdotool",
      spawn: fake.spawn,
    });
    child.__simulateExit(0);
    await pending;

    expect(fake.calls[0]!.command).toBe("/custom/xdotool");
  });

  test("resolves cleanly on exit code 0", async () => {
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);
    const pending = xdotoolClick({
      x: 5,
      y: 5,
      display: ":99",
      spawn: fake.spawn,
    });
    child.__simulateExit(0);
    await expect(pending).resolves.toBeUndefined();
  });

  test("rejects with exit code + stderr detail on non-zero exit", async () => {
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);
    const pending = xdotoolClick({
      x: 10,
      y: 20,
      display: ":99",
      spawn: fake.spawn,
    });
    child.__simulateStderr("Can't open display: :99\n");
    child.__simulateExit(1);
    await expect(pending).rejects.toThrow(/exit code 1/i);
    await expect(pending).rejects.toThrow(/Can't open display/i);
  });

  test("rejects with signal detail when killed", async () => {
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);
    const pending = xdotoolClick({
      x: 10,
      y: 20,
      display: ":99",
      spawn: fake.spawn,
    });
    child.__simulateExit(null, "SIGTERM");
    await expect(pending).rejects.toThrow(/signal SIGTERM/i);
  });

  test("rejects on spawn error", async () => {
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);
    const pending = xdotoolClick({
      x: 10,
      y: 20,
      display: ":99",
      spawn: fake.spawn,
    });
    child.__simulateSpawnError(new Error("ENOENT: xdotool"));
    await expect(pending).rejects.toThrow(/ENOENT/);
  });

  test("times out if xdotool never exits", async () => {
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);
    const pending = xdotoolClick({
      x: 10,
      y: 20,
      display: ":99",
      spawn: fake.spawn,
      timeoutMs: 10,
    });
    await expect(pending).rejects.toThrow(/timed out after 10ms/i);
    expect(child.__killSignals).toContain("SIGKILL");
  });
});
