/**
 * Unit tests for the v4l2loopback virtual-camera wrapper.
 *
 * The tests never touch a real `/dev/video*` node — every external effect
 * (fs.stat, fs.open, `v4l2-ctl` spawn, write-stream creation) is injected
 * as a shim so the suite is fully hermetic and runs on macOS CI where
 * v4l2loopback is unloadable.
 *
 * Coverage:
 *   - Missing device surfaces the actionable host-setup message.
 *   - Existing-but-wrong-file-type surfaces a distinct error.
 *   - `v4l2-ctl` is invoked with the expected argv (default + overrides).
 *   - `v4l2-ctl` non-zero exit propagates its stderr into the thrown error.
 *   - Successful open returns a handle with the configured geometry.
 *   - `close()` tears down the sink and the file handle (idempotent).
 *   - The exported missing-device message references the README section.
 */

import { describe, expect, test } from "bun:test";

import type { FileHandle } from "node:fs/promises";

import {
  buildV4l2CtlArgv,
  DEFAULT_FRAME_HEIGHT,
  DEFAULT_FRAME_WIDTH,
  DEFAULT_PIXEL_FORMAT,
  DEFAULT_VIDEO_DEVICE_PATH,
  missingDeviceMessage,
  openVideoDevice,
  type SpawnedV4l2Ctl,
  type VideoFrameSink,
} from "../src/media/video-device.js";

interface SinkState {
  writes: Uint8Array[];
  endCalls: number;
  destroyCalls: number;
  endedCallbacks: Array<() => void>;
}

function recordingSink(): { sink: VideoFrameSink; state: SinkState } {
  const state: SinkState = {
    writes: [],
    endCalls: 0,
    destroyCalls: 0,
    endedCallbacks: [],
  };
  const sink: VideoFrameSink = {
    write(chunk: Uint8Array): boolean {
      // Copy so callers mutating the source buffer can't retroactively
      // change what we've "received".
      state.writes.push(new Uint8Array(chunk));
      return true;
    },
    end(callback?: () => void) {
      state.endCalls += 1;
      if (callback) {
        state.endedCallbacks.push(callback);
        // Fire synchronously — this matches how Node's WriteStream.end
        // surfaces in tests without a real event loop waiting on the fs.
        callback();
      }
    },
    destroy() {
      state.destroyCalls += 1;
    },
  };
  return { sink, state };
}

interface FakeHandleState {
  closeCalls: number;
}

function fakeFileHandle(): { handle: FileHandle; state: FakeHandleState } {
  const state: FakeHandleState = { closeCalls: 0 };
  // Only the bits of `FileHandle` that `openVideoDevice` reaches for at
  // runtime — `close()` and (via the injected `createWriteStream` shim) the
  // absence of `createWriteStream` from the default path. The `as`-cast
  // keeps this tight without forcing a mirror of the full FileHandle type.
  const handle = {
    close: async () => {
      state.closeCalls += 1;
    },
  } as unknown as FileHandle;
  return { handle, state };
}

function fakeStat(options: {
  isCharacterDevice?: boolean;
  notFound?: boolean;
}): (devicePath: string) => Promise<{ isCharacterDevice(): boolean }> {
  return async () => {
    if (options.notFound) {
      const err: NodeJS.ErrnoException = new Error(
        "ENOENT: no such file or directory",
      );
      err.code = "ENOENT";
      throw err;
    }
    const isChar = options.isCharacterDevice ?? true;
    return { isCharacterDevice: () => isChar };
  };
}

function fakeSpawn(options: {
  argv?: string[][];
  exitCode?: number;
  stderr?: string;
}): (argv: readonly string[]) => SpawnedV4l2Ctl {
  return (argv: readonly string[]) => {
    options.argv?.push([...argv]);
    const stderrText = options.stderr ?? "";
    const stderrStream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (stderrText.length > 0) {
          controller.enqueue(new TextEncoder().encode(stderrText));
        }
        controller.close();
      },
    });
    return {
      stderr: stderrStream,
      exited: Promise.resolve(options.exitCode ?? 0),
    };
  };
}

describe("buildV4l2CtlArgv", () => {
  test("emits the v4l2-ctl --set-fmt-video command with interpolated values", () => {
    const argv = buildV4l2CtlArgv("/dev/video10", 1280, 720, "YU12");
    expect(argv).toEqual([
      "v4l2-ctl",
      "--device=/dev/video10",
      "--set-fmt-video=width=1280,height=720,pixelformat=YU12",
    ]);
  });
});

describe("missingDeviceMessage", () => {
  test("references the README section so operators can find the modprobe instructions", () => {
    const msg = missingDeviceMessage("/dev/video10");
    expect(msg).toContain("/dev/video10");
    expect(msg).toContain("v4l2loopback");
    expect(msg).toContain("README.md");
    // The exact README anchor matters so operators don't hunt for the
    // section — keep this guarded.
    expect(msg).toContain("Avatar (v4l2loopback) host setup");
    // Must mention both mitigations — host-side modprobe and the bot
    // --device passthrough.
    expect(msg).toContain("modprobe");
    expect(msg).toContain("--device");
  });
});

describe("openVideoDevice", () => {
  test("throws the host-setup message when the device node is missing", async () => {
    await expect(
      openVideoDevice("/dev/video10", {
        stat: fakeStat({ notFound: true }),
        spawn: fakeSpawn({}),
        open: async () => fakeFileHandle().handle,
        createWriteStream: () => recordingSink().sink,
      }),
    ).rejects.toThrow(missingDeviceMessage("/dev/video10"));
  });

  test("throws a distinct error when the path exists but is not a character device", async () => {
    let thrown: unknown;
    try {
      await openVideoDevice("/dev/video10", {
        stat: fakeStat({ isCharacterDevice: false }),
        spawn: fakeSpawn({}),
        open: async () => fakeFileHandle().handle,
        createWriteStream: () => recordingSink().sink,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).toContain("not a character device");
    // Must NOT be the "missing device" message — that would misdirect
    // operators to run modprobe when the real issue is a stray file.
    expect(msg).not.toContain("must be loaded on the HOST");
  });

  test("invokes v4l2-ctl with the configured geometry and returns the write stream", async () => {
    const argv: string[][] = [];
    const { handle } = fakeFileHandle();
    const { sink } = recordingSink();

    const result = await openVideoDevice("/dev/video10", {
      stat: fakeStat({}),
      spawn: fakeSpawn({ argv, exitCode: 0 }),
      open: async () => handle,
      createWriteStream: () => sink,
    });

    expect(argv).toHaveLength(1);
    expect(argv[0]).toEqual([
      "v4l2-ctl",
      "--device=/dev/video10",
      `--set-fmt-video=width=${DEFAULT_FRAME_WIDTH},height=${DEFAULT_FRAME_HEIGHT},pixelformat=${DEFAULT_PIXEL_FORMAT}`,
    ]);
    expect(result.devicePath).toBe("/dev/video10");
    expect(result.width).toBe(DEFAULT_FRAME_WIDTH);
    expect(result.height).toBe(DEFAULT_FRAME_HEIGHT);
    expect(result.pixelFormat).toBe(DEFAULT_PIXEL_FORMAT);
    expect(result.sink).toBe(sink);
  });

  test("honors width/height/pixelFormat overrides in the v4l2-ctl argv", async () => {
    const argv: string[][] = [];
    const { handle } = fakeFileHandle();
    const { sink } = recordingSink();

    const result = await openVideoDevice("/dev/video10", {
      width: 640,
      height: 480,
      pixelFormat: "YUYV",
      stat: fakeStat({}),
      spawn: fakeSpawn({ argv, exitCode: 0 }),
      open: async () => handle,
      createWriteStream: () => sink,
    });

    expect(argv[0]).toEqual([
      "v4l2-ctl",
      "--device=/dev/video10",
      "--set-fmt-video=width=640,height=480,pixelformat=YUYV",
    ]);
    expect(result.width).toBe(640);
    expect(result.height).toBe(480);
    expect(result.pixelFormat).toBe("YUYV");
  });

  test("surfaces v4l2-ctl stderr on non-zero exit", async () => {
    await expect(
      openVideoDevice("/dev/video10", {
        stat: fakeStat({}),
        spawn: fakeSpawn({
          exitCode: 1,
          stderr: "VIDIOC_S_FMT: failed: Invalid argument\n",
        }),
        open: async () => fakeFileHandle().handle,
        createWriteStream: () => recordingSink().sink,
      }),
    ).rejects.toThrow(/v4l2-ctl failed to configure \/dev\/video10 \(exit 1\)/);
  });

  test("rejects on non-positive geometry before touching the filesystem", async () => {
    const argv: string[][] = [];
    const opened: string[] = [];
    await expect(
      openVideoDevice("/dev/video10", {
        width: 0,
        height: 720,
        stat: fakeStat({}),
        spawn: fakeSpawn({ argv, exitCode: 0 }),
        open: async (p) => {
          opened.push(p);
          return fakeFileHandle().handle;
        },
        createWriteStream: () => recordingSink().sink,
      }),
    ).rejects.toThrow(/width\/height must be > 0/);
    // Guard invariant: we bail before any external side effects fire.
    expect(argv).toHaveLength(0);
    expect(opened).toHaveLength(0);
  });

  test("uses /dev/video10 as the default device path when none is supplied", async () => {
    const argv: string[][] = [];
    const { handle } = fakeFileHandle();
    const { sink } = recordingSink();

    await openVideoDevice(undefined, {
      stat: fakeStat({}),
      spawn: fakeSpawn({ argv, exitCode: 0 }),
      open: async () => handle,
      createWriteStream: () => sink,
    });

    expect(argv[0]).toEqual([
      "v4l2-ctl",
      `--device=${DEFAULT_VIDEO_DEVICE_PATH}`,
      `--set-fmt-video=width=${DEFAULT_FRAME_WIDTH},height=${DEFAULT_FRAME_HEIGHT},pixelformat=${DEFAULT_PIXEL_FORMAT}`,
    ]);
  });

  test("close() ends the sink and releases the underlying handle (idempotent)", async () => {
    const { handle, state: handleState } = fakeFileHandle();
    const { sink, state: sinkState } = recordingSink();

    const result = await openVideoDevice("/dev/video10", {
      stat: fakeStat({}),
      spawn: fakeSpawn({ exitCode: 0 }),
      open: async () => handle,
      createWriteStream: () => sink,
    });

    await result.close();
    // Second call — must not throw and must not double-close.
    await result.close();

    expect(sinkState.endCalls).toBe(1);
    expect(sinkState.destroyCalls).toBe(1);
    expect(handleState.closeCalls).toBe(1);
  });

  test("close() swallows a double fd-close (EBADF) from the write-stream teardown", async () => {
    const { sink, state: sinkState } = recordingSink();
    let closeCalls = 0;
    const handle = {
      close: async () => {
        closeCalls += 1;
        const err: NodeJS.ErrnoException = new Error("EBADF");
        err.code = "EBADF";
        throw err;
      },
    } as unknown as FileHandle;

    const result = await openVideoDevice("/dev/video10", {
      stat: fakeStat({}),
      spawn: fakeSpawn({ exitCode: 0 }),
      open: async () => handle,
      createWriteStream: () => sink,
    });

    // Must not reject — the second close is expected to happen when the
    // stream has already released the fd. Test validates that we swallow
    // the error rather than leaking it to the caller.
    await result.close();
    expect(closeCalls).toBe(1);
    expect(sinkState.endCalls).toBe(1);
  });
});
