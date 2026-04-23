/**
 * Unit tests for the xdotool-type primitive.
 *
 * We inject a fake `spawn` via `opts.spawn` so tests never actually exec
 * xdotool. The fake-child harness mirrors the one used in
 * `xdotool-click.test.ts` and `chrome-launcher.test.ts`: an EventEmitter
 * with `stderr`, `.kill()`, and `__simulateExit(code, signal?)`.
 */

import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";

import { xdotoolType } from "../src/browser/xdotool-type.js";

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

describe("xdotoolType", () => {
  test("spawns xdotool with type args and DISPLAY env", async () => {
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);

    const pending = xdotoolType({
      text: "hello world",
      display: ":99",
      spawn: fake.spawn,
    });
    child.__simulateExit(0);
    await pending;

    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]!.command).toBe("/usr/bin/xdotool");
    expect(fake.calls[0]!.args).toEqual([
      "type",
      "--delay",
      "25",
      "--clearmodifiers",
      "--",
      "hello world",
    ]);
    expect(fake.calls[0]!.options.env?.DISPLAY).toBe(":99");
  });

  test("forces a UTF-8 locale so xdotool can type non-ASCII characters", async () => {
    // Without an explicit UTF-8 locale, xdotool runs in POSIX/C and aborts
    // a chat message on the first multi-byte byte (em-dash, curly
    // apostrophe, emoji) with "Invalid multi-byte sequence encountered",
    // leaving a partial string in the composer. glibc's locale precedence
    // is LC_ALL > LC_CTYPE > LANG, so all three must be pinned — hosts
    // that export LC_ALL=C (common in CI and some dev shells) would
    // otherwise defeat a LANG-only override.
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);

    const pending = xdotoolType({
      text: "Hi — I'm the note-taker, don't mind me.",
      display: ":99",
      spawn: fake.spawn,
    });
    child.__simulateExit(0);
    await pending;

    expect(fake.calls[0]!.options.env?.LANG).toBe("C.UTF-8");
    expect(fake.calls[0]!.options.env?.LC_CTYPE).toBe("C.UTF-8");
    expect(fake.calls[0]!.options.env?.LC_ALL).toBe("C.UTF-8");
  });

  test("passes text starting with '-' safely via the '--' end-of-options marker", async () => {
    // Regression: without `--` before the text token, xdotool parses
    // anything starting with `-` as an option flag (e.g. a negative number
    // like `-14.7873` would be rejected as an unknown option).
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);

    const pending = xdotoolType({
      text: "-14.7873",
      display: ":99",
      spawn: fake.spawn,
    });
    child.__simulateExit(0);
    await pending;

    expect(fake.calls[0]!.args).toEqual([
      "type",
      "--delay",
      "25",
      "--clearmodifiers",
      "--",
      "-14.7873",
    ]);
    // The `--` token must appear immediately before the user-supplied text.
    const args = fake.calls[0]!.args;
    expect(args.indexOf("--")).toBe(args.length - 2);
  });

  test("honours custom delayMs", async () => {
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);

    const pending = xdotoolType({
      text: "abc",
      display: ":99",
      delayMs: 100,
      spawn: fake.spawn,
    });
    child.__simulateExit(0);
    await pending;

    expect(fake.calls[0]!.args).toEqual([
      "type",
      "--delay",
      "100",
      "--clearmodifiers",
      "--",
      "abc",
    ]);
  });

  test("honours custom binary override", async () => {
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);

    const pending = xdotoolType({
      text: "x",
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
    const pending = xdotoolType({
      text: "ok",
      display: ":99",
      spawn: fake.spawn,
    });
    child.__simulateExit(0);
    await expect(pending).resolves.toBeUndefined();
  });

  test("rejects with exit code + stderr detail on non-zero exit", async () => {
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);
    const pending = xdotoolType({
      text: "boom",
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
    const pending = xdotoolType({
      text: "boom",
      display: ":99",
      spawn: fake.spawn,
    });
    child.__simulateExit(null, "SIGTERM");
    await expect(pending).rejects.toThrow(/signal SIGTERM/i);
  });

  test("rejects on spawn error", async () => {
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);
    const pending = xdotoolType({
      text: "boom",
      display: ":99",
      spawn: fake.spawn,
    });
    child.__simulateSpawnError(new Error("ENOENT: xdotool"));
    await expect(pending).rejects.toThrow(/ENOENT/);
  });

  test("times out if xdotool never exits", async () => {
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);
    const pending = xdotoolType({
      text: "slow",
      display: ":99",
      spawn: fake.spawn,
      timeoutMs: 10,
    });
    await expect(pending).rejects.toThrow(/timed out after 10ms/i);
    expect(child.__killSignals).toContain("SIGKILL");
  });
});
