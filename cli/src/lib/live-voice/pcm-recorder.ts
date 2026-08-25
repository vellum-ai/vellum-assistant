/**
 * Capturing the user's voice from a terminal.
 *
 * The mirror image of {@link PcmPlayer}, and for the same reason: a native
 * audio addon is not an option for a package distributed as an npm tarball, so
 * this shells out to whichever recorder the machine already has and reads raw
 * PCM16 off its stdout.
 *
 * Unlike playback there is no second tier. A recorder either streams to stdout
 * or it is no use here, so the ladder is one shape of thing tried in order of
 * how likely it is to already be installed. `arecord` leads because it ships
 * with alsa-utils on Raspberry Pi OS and most desktop Linux, which is the
 * machine this exists for.
 *
 * With no recorder the session still opens and still speaks; the user types
 * instead. That is the same degradation the player makes, and it matters more
 * here: macOS and Windows ship nothing that captures to stdout, so an
 * un-provisioned machine is the normal case rather than the exception.
 */

import { spawn, type ChildProcess } from "node:child_process";

/**
 * How long a started recorder may produce nothing before it is called broken.
 *
 * A recorder that runs but never emits a byte is the normal shape of a denied
 * or still-pending microphone permission, which on macOS is what the very
 * first run looks like: the process starts, the prompt goes up, and stdout
 * stays empty. Nothing about that reaches the exit handler, so without a
 * deadline the session sits there looking live and hearing nothing.
 *
 * Generous enough not to trip on a slow device open (avfoundation takes about
 * a second) and short enough that the user is told before they have talked to
 * a dead microphone for long.
 */
const FIRST_AUDIO_DEADLINE_MS = 5_000;

import { isOnPath } from "./pcm-player.js";
import { LIVE_VOICE_AUDIO_FORMAT } from "./protocol.js";

export interface RecorderCommand {
  readonly name: string;
  /** Argv that streams raw PCM16 mono at `sampleRate` to stdout. */
  readonly args: (sampleRate: number) => string[];
  /** What to install when nothing on the ladder resolves. */
  readonly provides: string;
}

/**
 * Candidate recorders, most-likely-already-present first.
 *
 * Every entry must emit **headerless** signed 16-bit little-endian mono at the
 * requested rate. A container header would be sent to the daemon as if it were
 * audio, which does not fail loudly: it arrives as a fraction of a second of
 * noise at the start of the first utterance.
 */
const RECORDERS: readonly RecorderCommand[] = [
  {
    name: "arecord", // alsa-utils: Raspberry Pi OS and most desktop Linux
    provides: "alsa-utils",
    args: (sampleRate) => [
      "-q",
      "-t",
      "raw",
      "-f",
      "S16_LE",
      "-c",
      "1",
      "-r",
      String(sampleRate),
      "-",
    ],
  },
  {
    name: "sox",
    provides: "sox",
    args: (sampleRate) => [
      "-q",
      "-d", // default capture device
      "-t",
      "raw",
      "-b",
      "16",
      "-e",
      "signed-integer",
      "-c",
      "1",
      "-r",
      String(sampleRate),
      "-",
    ],
  },
  {
    name: "ffmpeg",
    provides: "ffmpeg",
    args: (sampleRate) => [
      "-hide_banner",
      "-loglevel",
      "error",
      // Capture backend by platform. The device selectors are the "system
      // default input" spelling for each: avfoundation indexes devices and
      // `:0` means "no video, first audio", while dshow names them.
      ...(process.platform === "darwin"
        ? ["-f", "avfoundation", "-i", ":0"]
        : process.platform === "win32"
          ? ["-f", "dshow", "-i", "audio=default"]
          : ["-f", "alsa", "-i", "default"]),
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "s16le",
      "pipe:1",
    ],
  },
];

/** Pick the best available recorder, or null when the machine has none. */
export function resolveRecorder(): RecorderCommand | null {
  for (const recorder of RECORDERS) {
    if (isOnPath(recorder.name)) {
      return recorder;
    }
  }
  return null;
}

/** What to tell a user who has no recorder at all. */
export function recorderInstallHint(): string {
  const names = RECORDERS.map((r) => r.provides).join(", ");
  return `install one of: ${names}`;
}

/**
 * Streams microphone PCM16 to a callback for as long as it is running.
 *
 * One instance per session rather than per turn. Turn boundaries are the
 * daemon's to find (`server_vad` reads them out of this stream), so the
 * recorder's job is only to keep the stream flowing and to stop cleanly.
 */
export class PcmRecorder {
  private readonly recorder: RecorderCommand | null;
  private child: ChildProcess | null = null;
  /** Set once the process has produced any audio at all. */
  private receivedAudio = false;
  private firstAudioTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly firstAudioDeadlineMs: number;

  constructor(
    recorder: RecorderCommand | null = resolveRecorder(),
    firstAudioDeadlineMs: number = FIRST_AUDIO_DEADLINE_MS,
  ) {
    this.recorder = recorder;
    this.firstAudioDeadlineMs = firstAudioDeadlineMs;
  }

  /** Name of the recorder in use, for the session banner. */
  get recorderName(): string | null {
    return this.recorder?.name ?? null;
  }

  get isRecording(): boolean {
    return this.child !== null;
  }

  /** Whether the microphone has produced a single byte since `start()`. */
  get hasCapturedAudio(): boolean {
    return this.receivedAudio;
  }

  /**
   * Begin capturing. `onChunk` receives raw PCM16 mono buffers as they arrive;
   * `onFailure` fires once if the recorder cannot run or dies unexpectedly.
   *
   * A recorder that exits on its own is reported rather than silently
   * restarted. The usual cause is a machine with no input device or a denied
   * microphone permission, and both are conditions the user has to fix; a
   * respawn loop would just hide them behind an apparently-live session.
   */
  start(
    onChunk: (pcm: Buffer) => void,
    onFailure: (reason: string) => void,
  ): boolean {
    if (!this.recorder || this.child) {
      return false;
    }
    let child: ChildProcess;
    try {
      child = spawn(
        this.recorder.name,
        this.recorder.args(LIVE_VOICE_AUDIO_FORMAT.sampleRate),
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      onFailure(
        err instanceof Error
          ? err.message
          : `Could not start ${this.recorder.name}`,
      );
      return false;
    }
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      this.receivedAudio = true;
      this.clearFirstAudioTimer();
      onChunk(chunk);
    });
    // The recorder's own diagnostics are the only clue to a failure the exit
    // code alone does not explain: no such device, permission denied, a busy
    // card. Keep the last of it to hand so the failure can name a cause.
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-400);
    });

    const fail = (reason: string) => {
      if (this.child !== child) {
        return;
      }
      this.child = null;
      this.clearFirstAudioTimer();
      child.kill("SIGKILL");
      onFailure(reason);
    };
    // Silence is its own failure, and not one the exit handler ever sees.
    this.firstAudioTimer = setTimeout(() => {
      this.firstAudioTimer = null;
      if (this.child !== child || this.receivedAudio) {
        return;
      }
      const detail = stderrTail.trim();
      fail(
        `${this.recorder?.name} produced no audio` +
          (detail ? `: ${detail}` : "") +
          ". Check that the terminal is allowed to use the microphone.",
      );
    }, this.firstAudioDeadlineMs);

    child.on("error", (err) => fail(err.message));
    child.on("exit", (code) => {
      const detail = stderrTail.trim();
      fail(
        detail
          ? `${this.recorder?.name} exited (${code}): ${detail}`
          : `${this.recorder?.name} exited (${code})`,
      );
    });
    return true;
  }

  /** Stop capturing. Idempotent, and safe before `start()`. */
  stop(): void {
    const child = this.child;
    this.child = null;
    this.clearFirstAudioTimer();
    if (child) {
      // Detach the handlers first: a deliberate stop is not a failure, and the
      // exit listener would otherwise report it as one.
      child.removeAllListeners("exit");
      child.removeAllListeners("error");
      child.stdout?.removeAllListeners("data");
      child.kill("SIGKILL");
    }
  }

  private clearFirstAudioTimer(): void {
    if (this.firstAudioTimer !== null) {
      clearTimeout(this.firstAudioTimer);
      this.firstAudioTimer = null;
    }
  }
}
