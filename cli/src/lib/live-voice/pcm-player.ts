/**
 * Playing the assistant's voice out of a terminal.
 *
 * `tts_audio` frames carry PCM16 mono at a sample rate the frame states, which
 * needs no decoding, only somewhere to put it. There is no portable way to do
 * that from Node without a native addon, and a native addon is not an option
 * for a package distributed as an npm tarball, so this shells out to whichever
 * player the machine already has.
 *
 * Two tiers, because they are genuinely different experiences:
 *
 * - **Streaming** (`ffplay`, `play`/sox, `aplay`): PCM is piped in as it
 *   arrives, so the assistant starts speaking while it is still thinking, and
 *   a barge-in cuts it off mid-word. This is the real thing.
 * - **Buffered** (`afplay`): cannot read stdin, so the turn's audio is
 *   collected, wrapped in a WAV header, and played once the turn finishes.
 *   Kept because it is the only player that ships with macOS. Without it the
 *   feature is silent on a stock Mac, which is most of them.
 *
 * With no player at all the session still runs; the reply is printed and never
 * spoken. That is a degradation worth having: a headless box is exactly where
 * someone would rather read the answer than not get one.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How a resolved player consumes audio. */
export type PlaybackMode = "streaming" | "buffered" | "silent";

export interface PlayerCommand {
  readonly mode: Exclude<PlaybackMode, "silent">;
  readonly name: string;
  /** Argv for a given sample rate. */
  readonly args: (sampleRate: number, filePath?: string) => string[];
}

/**
 * Candidate players, best first.
 *
 * Order is by experience, not availability: a machine with both `ffplay` and
 * `afplay` should stream rather than wait for the turn to end.
 */
const PLAYERS: readonly PlayerCommand[] = [
  {
    mode: "streaming",
    name: "ffplay",
    // No channel-count flag. ffplay 7.x rejects `-ac` outright ("Option not
    // found"), and `-ch_layout` does not exist before 5.1, so either spelling
    // is broken on some supported machine. The pcm demuxer's `ch_layout`
    // defaults to mono on every version, which is exactly what these frames
    // are, so the portable answer is to say nothing and take the default.
    //
    // Getting this wrong fails silently: ffplay exits immediately, `adopt()`
    // settles on that exit like any finished playback, and the session prints
    // "Speaking via ffplay" while making no sound at all.
    args: (sampleRate) => [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nodisp",
      "-autoexit",
      "-f",
      "s16le",
      "-ar",
      String(sampleRate),
      "-i",
      "pipe:0",
    ],
  },
  {
    mode: "streaming",
    name: "play", // sox
    args: (sampleRate) => [
      "-q",
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
    mode: "streaming",
    name: "aplay", // alsa-utils
    args: (sampleRate) => [
      "-q",
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
    mode: "buffered",
    name: "afplay", // macOS, stdin-incapable
    args: (_sampleRate, filePath) => [filePath ?? ""],
  },
];

/**
 * Whether a command resolves on this machine.
 *
 * Platform-split rather than one clever shell invocation: `command -v` is a
 * POSIX shell builtin, and on Windows the spawned shell is `cmd.exe`, which
 * has no such builtin. A single POSIX form there fails for every candidate and
 * silently downgrades the session to text-only on a machine that has ffplay
 * installed.
 */
export function isOnPath(command: string): boolean {
  const [probe, args] =
    process.platform === "win32"
      ? ["where", [command]]
      : ["/bin/sh", ["-c", `command -v ${command}`]];
  try {
    execFileSync(probe, args, {
      stdio: "ignore",
      timeout: 2000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/** Pick the best available player, or null when the machine has none. */
export function resolvePlayer(): PlayerCommand | null {
  for (const player of PLAYERS) {
    if (isOnPath(player.name)) {
      return player;
    }
  }
  return null;
}

/**
 * Plays a turn's audio, one turn at a time.
 *
 * A turn is `write()`n chunk by chunk and closed with either `finish()` (let
 * it drain) or `stop()` (cut it off now, for barge-in and Ctrl+C). Both are
 * safe to call when nothing is playing.
 */
export class PcmPlayer {
  private readonly player: PlayerCommand | null;
  private child: ChildProcess | null = null;
  /** Sample rate the running process was started for. */
  private activeSampleRate: number | null = null;
  /** Buffered-mode accumulator for the current turn. */
  private pending: Buffer[] = [];
  private tempDir: string | null = null;
  private tempSeq = 0;
  /**
   * Resolvers for `finish()` callers still waiting on the current process.
   * Held rather than resolved eagerly because "the bytes were handed over" and
   * "the speaker went quiet" are different moments, and callers care about the
   * second one.
   */
  private idleWaiters: (() => void)[] = [];

  constructor(player: PlayerCommand | null = resolvePlayer()) {
    this.player = player;
  }

  get mode(): PlaybackMode {
    return this.player?.mode ?? "silent";
  }

  /** Name of the player in use, for the session banner. */
  get playerName(): string | null {
    return this.player?.name ?? null;
  }

  /** Queue one PCM16 chunk. */
  write(pcm: Buffer, sampleRate: number): void {
    if (!this.player) {
      return;
    }
    if (this.player.mode === "buffered") {
      this.activeSampleRate = sampleRate;
      this.pending.push(pcm);
      return;
    }
    // A sample-rate change mid-turn would be played at the wrong speed by an
    // already-running process, so start a new one for it. In practice the rate
    // is fixed per provider and this never fires within a turn; across turns
    // (a voice change) it does.
    if (this.child && this.activeSampleRate !== sampleRate) {
      this.endStream();
    }
    if (!this.child) {
      this.startStream(sampleRate);
    }
    this.child?.stdin?.write(pcm);
  }

  /**
   * The turn's audio is complete. Resolves when the machine actually stops
   * making noise, not when the last byte is handed over.
   *
   * The distinction is the whole point. Closing a streaming player's stdin
   * leaves seconds of audio still buffered inside it, and a buffered player
   * has not even started yet at this moment. A caller that treated either as
   * "done" would hand the prompt back while the assistant is still talking,
   * so Ctrl+C would quit the session instead of interrupting, and the next
   * turn would start a second player over the top of the first.
   */
  finish(): Promise<void> {
    if (!this.player) {
      return Promise.resolve();
    }
    if (this.player.mode === "buffered") {
      this.playBuffered();
    } else {
      this.endStream();
    }
    if (!this.child) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /** Whether audio is still playing. */
  get isPlaying(): boolean {
    return this.child !== null;
  }

  /**
   * Cut playback off immediately and drop anything not yet played. This is
   * barge-in: an interrupted turn's audio is for a turn that no longer exists,
   * so draining it would be wrong.
   */
  stop(): void {
    this.pending = [];
    const child = this.child;
    this.child = null;
    this.activeSampleRate = null;
    if (child) {
      // Destroy stdin first: killing a player that is still being written to
      // raises EPIPE on the next write instead of ending quietly.
      child.stdin?.destroy();
      child.kill("SIGKILL");
    }
    this.releaseIdleWaiters();
  }

  /** Release the temp directory buffered playback used, if any. */
  dispose(): void {
    this.stop();
    if (this.tempDir) {
      rmSync(this.tempDir, { recursive: true, force: true });
      this.tempDir = null;
    }
  }

  private startStream(sampleRate: number): void {
    if (!this.player) {
      return;
    }
    const child = spawn(this.player.name, this.player.args(sampleRate), {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    this.adopt(child);
    this.activeSampleRate = sampleRate;
  }

  private endStream(): void {
    // Closing stdin lets the player finish what is already queued and exit on
    // its own; this is the ordinary end of a turn, not an interruption. The
    // process stays adopted so `finish()` can wait for it to actually exit.
    this.child?.stdin?.end();
  }

  private playBuffered(): void {
    if (!this.player || this.pending.length === 0) {
      return;
    }
    const pcm = Buffer.concat(this.pending);
    this.pending = [];
    const sampleRate = this.activeSampleRate ?? 24000;

    if (!this.tempDir) {
      this.tempDir = mkdtempSync(join(tmpdir(), "vellum-voice-"));
    }
    const filePath = join(this.tempDir, `turn-${this.tempSeq++}.wav`);
    writeFileSync(filePath, wrapPcmAsWav(pcm, sampleRate));

    this.adopt(
      spawn(this.player.name, this.player.args(sampleRate, filePath), {
        stdio: "ignore",
        windowsHide: true,
      }),
    );
  }

  /**
   * Take ownership of a player process and wire its exit back to whoever is
   * waiting on `finish()`.
   *
   * A player that dies mid-turn, or was never really there, must not take the
   * session with it: an unhandled `error` event would, and a `finish()` that
   * never resolved would wedge the prompt just as surely.
   */
  private adopt(child: ChildProcess): void {
    this.child = child;
    child.stdin?.on("error", () => {});
    const settle = () => {
      if (this.child === child) {
        this.child = null;
        this.activeSampleRate = null;
      }
      this.releaseIdleWaiters();
    };
    child.on("error", settle);
    child.on("exit", settle);
  }

  private releaseIdleWaiters(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
}

/**
 * Wrap raw PCM16 mono in a 44-byte canonical WAV header.
 *
 * Only for the buffered path. A streaming player is told the format on its
 * command line and wants headerless bytes.
 */
export function wrapPcmAsWav(pcm: Buffer, sampleRate: number): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}
