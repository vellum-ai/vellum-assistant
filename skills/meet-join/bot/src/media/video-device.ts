/**
 * Virtual-camera (v4l2loopback) handle for the meet-bot.
 *
 * The avatar renderer streams raw video frames into a v4l2loopback device
 * node (`/dev/video10` by default). Chrome, launched with
 * `--use-fake-device-for-media-stream=false --use-file-for-fake-video-capture=
 * /dev/video10` or simply selecting the loopback device as the default
 * `videoinput`, then sees those frames as the bot's webcam inside the Meet
 * tab.
 *
 * Responsibilities of this module:
 *
 *   1. Verify the device node exists inside the container. If it doesn't,
 *      the host has not loaded v4l2loopback — surface a clear error pointing
 *      operators at the README's host-setup section.
 *   2. Configure the device's pixel format via `v4l2-ctl`. Defaults match the
 *      renderer's output: 1280x720 YU12 (planar YUV 4:2:0 — byte-compatible
 *      with the Y4M format ffmpeg produces).
 *   3. Return a writable handle that downstream code can push raw frame
 *      bytes into. The handle owns the underlying file descriptor and tears
 *      it down on `close()`.
 *
 * Device I/O goes through `node:fs`'s async `open` + a file-handle backed
 * `createWriteStream`. The caller is responsible for writing frames at the
 * correct rate — this module does not paces or buffers; it just hands back a
 * stream that writes land on the kernel's v4l2 ring directly.
 *
 * Like the audio-capture / audio-playback modules, every external effect
 * (filesystem probes, `v4l2-ctl` invocation, stream creation) is injectable
 * via options so the unit tests can verify the wiring without requiring a
 * real v4l2loopback device on the test runner.
 */

import { constants as fsConstants } from "node:fs";
import { stat, open as fsOpen, type FileHandle } from "node:fs/promises";
import type { WriteStream } from "node:fs";
import type { Subprocess } from "bun";

import { AVATAR_DEVICE_PATH_DEFAULT } from "../../../shared/avatar-device-path.js";

/**
 * Default device path for the virtual camera — loaded by host modprobe.
 * Re-exports the shared
 * {@link ../../../shared/avatar-device-path.js AVATAR_DEVICE_PATH_DEFAULT}
 * so this value stays locked to the launcher's `DEFAULT_AVATAR_DEVICE_PATH`,
 * the workspace config default, and the CLI's device-passthrough default.
 */
export const DEFAULT_VIDEO_DEVICE_PATH = AVATAR_DEVICE_PATH_DEFAULT;

/**
 * Default frame geometry. 720p matches what the renderer produces today and
 * what Meet's pipeline is happiest ingesting; callers can override if a
 * specific renderer demands a different output size.
 */
export const DEFAULT_FRAME_WIDTH = 1280;
export const DEFAULT_FRAME_HEIGHT = 720;

/**
 * Default pixel format — YU12 is planar YUV 4:2:0, byte-compatible with the
 * Y4M frames ffmpeg emits and widely supported by Chrome's camera ingest.
 */
export const DEFAULT_PIXEL_FORMAT = "YU12";

/** Path to `v4l2-ctl`. Provided by the `v4l2loopback-utils` apt package. */
const V4L2_CTL_BIN = "v4l2-ctl";

/**
 * Minimal slice of `Bun.spawn`'s return type that `openVideoDevice`
 * actually reads from. Tests provide a shim rather than a full Subprocess.
 */
export interface SpawnedV4l2Ctl {
  /** stderr stream — drained on failure for diagnostic context. */
  stderr: ReadableStream<Uint8Array> | null;
  /** Resolves with the child's exit code. */
  exited: Promise<number>;
}

export type V4l2CtlSpawnFactory = (argv: readonly string[]) => SpawnedV4l2Ctl;

/**
 * Injectable opener for the underlying device node. Defaults to
 * `fs.promises.open(..., "w")` which yields a `FileHandle`; the handle is
 * then used to construct the writable stream returned to the caller.
 */
export type VideoFileOpener = (devicePath: string) => Promise<FileHandle>;

/**
 * Minimal slice of the writable stream we return to callers. Matches
 * Node's {@link WriteStream} at runtime; declared as a narrow interface so
 * tests can inject a shim without implementing the full fs.WriteStream
 * surface.
 */
export interface VideoFrameSink {
  write(chunk: Uint8Array): boolean;
  end(callback?: () => void): void;
  destroy(err?: Error): void;
}

/**
 * Injectable factory that turns a `FileHandle` into a writable stream.
 * Default delegates to `FileHandle.createWriteStream`.
 */
export type VideoWriteStreamFactory = (handle: FileHandle) => VideoFrameSink;

/**
 * Optional `fs.stat` shim — used to verify the device node exists before
 * we attempt to open it. Default is `fs.promises.stat`.
 */
export type VideoFileStat = (devicePath: string) => Promise<{
  isCharacterDevice(): boolean;
}>;

export interface OpenVideoDeviceOptions {
  width?: number;
  height?: number;
  pixelFormat?: string;
  /** Test hook — Bun.spawn-shaped factory for `v4l2-ctl`. */
  spawn?: V4l2CtlSpawnFactory;
  /** Test hook — replaces `fs.promises.open`. */
  open?: VideoFileOpener;
  /** Test hook — replaces `fs.promises.stat`. */
  stat?: VideoFileStat;
  /** Test hook — replaces `FileHandle.createWriteStream`. */
  createWriteStream?: VideoWriteStreamFactory;
}

/**
 * Writable handle for the virtual camera. `sink` is the write target for
 * raw frame bytes; `close()` tears down the underlying file descriptor
 * and resolves once the kernel has flushed any outstanding writes.
 */
export interface VideoDeviceHandle {
  /** Absolute device path this handle is bound to. */
  readonly devicePath: string;
  /** Frame geometry the device was configured with. */
  readonly width: number;
  readonly height: number;
  readonly pixelFormat: string;
  /** Writable sink for raw frame bytes. */
  readonly sink: VideoFrameSink;
  /** Tear down the device handle. Idempotent. */
  close(): Promise<void>;
}

/**
 * Default `Bun.spawn` wrapper — captures stderr so we can surface the tool's
 * own error message when the configure call fails.
 */
function defaultSpawn(argv: readonly string[]): SpawnedV4l2Ctl {
  const proc: Subprocess = Bun.spawn(argv as string[], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stderr: proc.stderr as ReadableStream<Uint8Array> | null,
    exited: proc.exited,
  };
}

/**
 * Default file opener — writes only. We don't need read access because the
 * kernel-side v4l2loopback driver handles the consumer side for Chrome.
 */
async function defaultOpen(devicePath: string): Promise<FileHandle> {
  return fsOpen(devicePath, fsConstants.O_WRONLY);
}

/**
 * Default stat shim. Raises the same `ENOENT` Error Node does natively; the
 * caller wraps that into the user-facing "host modprobe missing" message.
 */
async function defaultStat(
  devicePath: string,
): Promise<{ isCharacterDevice(): boolean }> {
  return stat(devicePath);
}

function defaultCreateWriteStream(handle: FileHandle): VideoFrameSink {
  // `FileHandle.createWriteStream` returns a full Node WriteStream.
  const stream: WriteStream = handle.createWriteStream();
  return stream;
}

/**
 * Build the argv for `v4l2-ctl --device=<path> --set-fmt-video=width=<w>,
 * height=<h>,pixelformat=<fmt>`. Exported so tests can assert on the shape
 * without replicating the string interpolation in-line.
 */
export function buildV4l2CtlArgv(
  devicePath: string,
  width: number,
  height: number,
  pixelFormat: string,
): readonly string[] {
  return [
    V4L2_CTL_BIN,
    `--device=${devicePath}`,
    `--set-fmt-video=width=${width},height=${height},pixelformat=${pixelFormat}`,
  ];
}

/**
 * Human-facing error surfaced when `/dev/video10` doesn't exist in the
 * container. Exported so tests can assert against the exact wording and so
 * callers surfacing this to UX can rely on a stable prefix.
 */
export function missingDeviceMessage(devicePath: string): string {
  return (
    `v4l2 device ${devicePath} not found inside the container. ` +
    `The v4l2loopback kernel module must be loaded on the HOST and the ` +
    `device node bind-mounted into the bot container with ` +
    `\`--device=${devicePath}:${devicePath}\`. ` +
    `See skills/meet-join/bot/README.md ("Avatar (v4l2loopback) host setup") ` +
    `for the one-time \`modprobe v4l2loopback\` instructions.`
  );
}

/**
 * Open + configure a v4l2loopback device node, returning a writable handle
 * callers push raw frame bytes into. Throws with a clear message if the
 * device doesn't exist, and with `v4l2-ctl`'s own stderr if the format-set
 * step fails.
 *
 * The handle's `sink` is the target for frame writes. Call `close()` to
 * tear down the file descriptor.
 */
export async function openVideoDevice(
  devicePath: string = DEFAULT_VIDEO_DEVICE_PATH,
  opts: OpenVideoDeviceOptions = {},
): Promise<VideoDeviceHandle> {
  const width = opts.width ?? DEFAULT_FRAME_WIDTH;
  const height = opts.height ?? DEFAULT_FRAME_HEIGHT;
  const pixelFormat = opts.pixelFormat ?? DEFAULT_PIXEL_FORMAT;
  const spawn = opts.spawn ?? defaultSpawn;
  const open = opts.open ?? defaultOpen;
  const statDev = opts.stat ?? defaultStat;
  const createWriteStream = opts.createWriteStream ?? defaultCreateWriteStream;

  if (width <= 0 || height <= 0) {
    throw new Error(
      `openVideoDevice: width/height must be > 0 (got ${width}x${height})`,
    );
  }

  // 1. Confirm the device node exists. A missing node = missing host-side
  //    modprobe or a missing `--device` passthrough at `docker run` time.
  //    Surface both possibilities in a single actionable error.
  try {
    const info = await statDev(devicePath);
    if (!info.isCharacterDevice()) {
      throw new Error(
        `${devicePath} exists but is not a character device — is something ` +
          `else (e.g. a stray regular file) occupying the path?`,
      );
    }
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ENOENT") {
      throw new Error(missingDeviceMessage(devicePath));
    }
    throw err;
  }

  // 2. Configure the device's pixel format. Must succeed before we open the
  //    file descriptor for writes — otherwise Chrome may negotiate an
  //    incompatible format and silently drop frames.
  const argv = buildV4l2CtlArgv(devicePath, width, height, pixelFormat);
  const proc = spawn(argv);
  const stderrText = proc.stderr ? await new Response(proc.stderr).text() : "";
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const trimmed = stderrText.trim();
    const detail = trimmed.length > 0 ? `: ${trimmed}` : "";
    throw new Error(
      `v4l2-ctl failed to configure ${devicePath} (exit ${exitCode})${detail}`,
    );
  }

  // 3. Open the device for writing and wrap in a write stream.
  const handle = await open(devicePath);
  let sink: VideoFrameSink;
  try {
    sink = createWriteStream(handle);
  } catch (err) {
    // If stream creation throws, the FileHandle owns the fd — close it so
    // we don't leak.
    await handle.close().catch(() => {
      /* best-effort */
    });
    throw err;
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // End the stream first so any queued writes drain, then release the
    // underlying fd. Both are best-effort on shutdown.
    await new Promise<void>((resolve) => {
      try {
        sink.end(() => resolve());
      } catch {
        resolve();
      }
    });
    try {
      sink.destroy();
    } catch {
      // Destroy is best-effort if the stream already ended.
    }
    // A `WriteStream` built from a `FileHandle` closes the handle itself
    // when it ends. Closing twice surfaces `EBADF`; swallow that — the fd
    // is already gone.
    try {
      await handle.close();
    } catch {
      /* already closed by the write-stream teardown */
    }
  };

  return {
    devicePath,
    width,
    height,
    pixelFormat,
    sink,
    close,
  };
}
