import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import {
  PULSE_SETUP_SCRIPT_PATH,
  setupPulseAudio,
  teardownPulseAudio,
} from "../src/media/pulse.js";

/**
 * Unit tests for the PulseAudio wrapper.
 *
 * PulseAudio itself is unavailable on macOS developer machines and typical
 * CI runners, so these tests never invoke the real script. Instead they
 * inject a narrow shim mirroring the slice of `Bun.spawn` that `pulse.ts`
 * depends on, and verify the wrapper invokes bash with the right script
 * path and propagates exit codes / stderr correctly.
 */

type SpawnArgs = Parameters<typeof Bun.spawn>;
type SpawnReturn = ReturnType<typeof Bun.spawn>;

interface FakeProcess {
  cmd: string[];
  stderrText: string;
  exitCode: number;
}

function makeFakeSpawn(processes: FakeProcess[]): {
  spawn: typeof Bun.spawn;
  calls: SpawnArgs[];
} {
  const calls: SpawnArgs[] = [];
  let index = 0;

  const spawn = ((...args: SpawnArgs): SpawnReturn => {
    calls.push(args);
    const fake = processes[index++];
    if (!fake) {
      throw new Error(`fake spawn invoked more times than expected`);
    }
    // Record the argv we were called with so callers can assert on it.
    fake.cmd = args[0] as string[];

    const stderrStream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (fake.stderrText.length > 0) {
          controller.enqueue(new TextEncoder().encode(fake.stderrText));
        }
        controller.close();
      },
    });

    return {
      stderr: stderrStream,
      exited: Promise.resolve(fake.exitCode),
    } as unknown as SpawnReturn;
  }) as typeof Bun.spawn;

  return { spawn, calls };
}

describe("setupPulseAudio", () => {
  test("resolves the script path relative to the module file", () => {
    // The script must live next to pulse.ts so the Dockerfile COPY and the
    // runtime resolution agree. If this ever breaks, pulse.ts needs to be
    // updated in lock-step with the Dockerfile.
    expect(PULSE_SETUP_SCRIPT_PATH.endsWith("/media/pulse-setup.sh")).toBe(
      true,
    );
    expect(existsSync(PULSE_SETUP_SCRIPT_PATH)).toBe(true);
    // Sanity: the script must be executable in the repo as well, since the
    // Dockerfile relies on preserving the executable bit from COPY.
    const mode = statSync(PULSE_SETUP_SCRIPT_PATH).mode;
    expect((mode & 0o111) !== 0).toBe(true);
  });

  test("invokes bash with the setup script and resolves on exit 0", async () => {
    const fake: FakeProcess = {
      cmd: [],
      stderrText: "",
      exitCode: 0,
    };
    const { spawn, calls } = makeFakeSpawn([fake]);

    await setupPulseAudio(spawn);

    expect(calls.length).toBe(1);
    const [argv] = calls[0]!;
    expect(argv).toEqual(["bash", PULSE_SETUP_SCRIPT_PATH]);
  });

  test("rejects with exit code + stderr when the script fails", async () => {
    const fake: FakeProcess = {
      cmd: [],
      stderrText: "pulse-setup: PulseAudio daemon did not come up\n",
      exitCode: 1,
    };
    const { spawn } = makeFakeSpawn([fake]);

    let thrown: unknown;
    try {
      await setupPulseAudio(spawn);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).toContain("exit code 1");
    expect(msg).toContain("PulseAudio daemon did not come up");
  });

  test("error message omits the colon when stderr is empty", async () => {
    const fake: FakeProcess = {
      cmd: [],
      stderrText: "",
      exitCode: 42,
    };
    const { spawn } = makeFakeSpawn([fake]);

    let thrown: unknown;
    try {
      await setupPulseAudio(spawn);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "pulse-setup.sh failed with exit code 42",
    );
  });
});

describe("teardownPulseAudio", () => {
  test("invokes `pulseaudio --kill`", async () => {
    const fake: FakeProcess = {
      cmd: [],
      stderrText: "",
      exitCode: 0,
    };
    const { spawn, calls } = makeFakeSpawn([fake]);

    await teardownPulseAudio(spawn);

    expect(calls.length).toBe(1);
    const [argv] = calls[0]!;
    expect(argv).toEqual(["pulseaudio", "--kill"]);
  });

  test("swallows spawn errors (best-effort)", async () => {
    const spawn = (() => {
      throw new Error("spawn failed");
    }) as unknown as typeof Bun.spawn;

    // Must not throw.
    await teardownPulseAudio(spawn);
  });

  test("tolerates a non-zero exit from pulseaudio --kill", async () => {
    const fake: FakeProcess = {
      cmd: [],
      stderrText: "no daemon running",
      exitCode: 1,
    };
    const { spawn } = makeFakeSpawn([fake]);

    // Must not throw even if the daemon was already gone.
    await teardownPulseAudio(spawn);
  });
});
