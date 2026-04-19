/**
 * Unit tests for the chrome-launcher primitive.
 *
 * We inject a fake `spawn` via `opts.spawn` so the tests never actually exec
 * chromium. Each fake child process exposes `.kill(signal)`,
 * `.on("exit", cb)`, and `.stdout`/`.stderr` event emitters, mirroring the
 * shape of a real `ChildProcess`.
 *
 * The CDP-flag absence check (Test 3) is load-bearing: re-introducing any of
 * `--remote-debugging-port`, `--remote-debugging-pipe`, or `--enable-automation`
 * would reactivate Meet's BotGuard CDP detection and silently break the bot.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { launchChrome } from "../src/browser/chrome-launcher.js";

interface SpawnCall {
  command: string;
  args: string[];
  options: { env?: NodeJS.ProcessEnv; stdio?: unknown };
}

interface FakeChild extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals) => boolean;
  __killSignals: NodeJS.Signals[];
  /** Simulate the child exiting. */
  __simulateExit: (code: number) => void;
}

/**
 * Build a fake child-process surface that can be steered from the test.
 *
 * `autoExitOn` controls whether the fake exits automatically when it
 * receives a given signal (mirrors real Chrome's response to SIGTERM).
 * Tests can leave it empty to simulate a hung process that requires
 * SIGKILL escalation.
 */
function makeFakeChild(opts?: {
  autoExitOn?: Set<NodeJS.Signals>;
  pid?: number;
}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = opts?.pid ?? 54321;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.__killSignals = [];

  const autoExitOn = opts?.autoExitOn;

  child.kill = (signal?: NodeJS.Signals): boolean => {
    const sig = signal ?? "SIGTERM";
    child.__killSignals.push(sig);
    if (autoExitOn?.has(sig)) {
      // Defer the exit to the next microtask so the caller sees the kill
      // return before the exit event fires.
      queueMicrotask(() => child.__simulateExit(0));
    }
    return true;
  };

  child.__simulateExit = (code: number): void => {
    if (child.exitCode !== null) return;
    child.exitCode = code;
    child.emit("exit", code, null);
  };

  return child;
}

/**
 * Build a fake `spawn` function that records calls and returns a caller-
 * supplied fake child. Typed loosely as `never` to match `typeof spawn` in
 * `launchChrome`'s signature without needing the full overload surface.
 */
function makeFakeSpawn(fakeChild: FakeChild): {
  spawn: never;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const impl = (
    command: string,
    args: readonly string[],
    options: { env?: NodeJS.ProcessEnv; stdio?: unknown },
  ) => {
    calls.push({ command, args: [...args], options });
    return fakeChild;
  };
  return { spawn: impl as unknown as never, calls };
}

const BASE_OPTS = {
  meetingUrl: "https://meet.google.com/abc-defg-hij",
  displayNumber: ":99",
  extensionPath: "/app/ext",
  userDataDir: "/tmp/profile",
};

describe("launchChrome", () => {
  test("defaults chromeBinary to /usr/bin/chromium", async () => {
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);

    await launchChrome({ ...BASE_OPTS, spawn: fake.spawn });

    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]!.command).toBe("/usr/bin/chromium");
  });

  test("argv contains extension, user-data-dir, --no-sandbox, and meeting URL", async () => {
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);

    await launchChrome({ ...BASE_OPTS, spawn: fake.spawn });

    const { args } = fake.calls[0]!;
    expect(args).toContain("--load-extension=/app/ext");
    expect(args).toContain("--user-data-dir=/tmp/profile");
    expect(args).toContain("--no-sandbox");
    expect(args).toContain("https://meet.google.com/abc-defg-hij");
  });

  test("argv does NOT contain any CDP-related flag", async () => {
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);

    await launchChrome({ ...BASE_OPTS, spawn: fake.spawn });

    const { args } = fake.calls[0]!;
    // BotGuard trip-wires — their absence is the whole point of this launcher.
    for (const arg of args) {
      expect(arg.startsWith("--remote-debugging-port")).toBe(false);
      expect(arg.startsWith("--remote-debugging-pipe")).toBe(false);
      expect(arg.startsWith("--enable-automation")).toBe(false);
    }
  });

  test("spawn env includes DISPLAY, PULSE_SOURCE, PULSE_SINK", async () => {
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);

    await launchChrome({
      ...BASE_OPTS,
      displayNumber: ":42",
      spawn: fake.spawn,
    });

    const env = fake.calls[0]!.options.env;
    expect(env?.DISPLAY).toBe(":42");
    expect(env?.PULSE_SOURCE).toBe("bot_mic");
    expect(env?.PULSE_SINK).toBe("meet_capture");
    // process.env passthrough — PATH must survive so Chrome can find helpers.
    expect(env?.PATH).toBe(process.env.PATH);
  });

  test("stop() sends SIGTERM, escalates to SIGKILL when child hangs", async () => {
    // Fake child deliberately ignores SIGTERM so we hit the SIGKILL path.
    const child = makeFakeChild({ autoExitOn: new Set(["SIGKILL"]) });
    const fake = makeFakeSpawn(child);

    // Compress the grace window so the test doesn't have to wait 5s. The
    // production default is 5000ms; the contract under test is "SIGTERM,
    // wait, then SIGKILL", independent of the specific interval.
    const handle = await launchChrome({
      ...BASE_OPTS,
      spawn: fake.spawn,
      sigkillGraceMs: 50,
    });
    await handle.stop();

    expect(child.__killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("stop() is idempotent — signals fire only once", async () => {
    const child = makeFakeChild({ autoExitOn: new Set(["SIGTERM"]) });
    const fake = makeFakeSpawn(child);

    const handle = await launchChrome({
      ...BASE_OPTS,
      spawn: fake.spawn,
      sigkillGraceMs: 50,
    });

    await handle.stop();
    await handle.stop();
    await handle.stop();

    // Only the first call should have issued signals; subsequent calls are
    // no-ops that await the already-settled exit promise.
    expect(child.__killSignals).toEqual(["SIGTERM"]);
  });
});
