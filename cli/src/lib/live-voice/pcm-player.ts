/**
 * Playing the assistant's voice out of a terminal.
 *
 * `tts_audio` frames carry PCM16 mono at a sample rate the frame states, which
 * needs no decoding — only somewhere to put it. There is no portable way to do
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
 *   Kept because it is the only player that ships with macOS — without it the
 *   feature is silent on a stock Mac, which is most of them.
 *
 * With no player at all the session still runs; the reply is printed and never
 * spoken. That is a degradation worth having: a headless box is exactly where
 * someone would rather read the answer than not get one.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How a resolved player consumes audio. */
export type PlaybackMode = "streaming" | "buffered" | "silent";

interface PlayerCommand {
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
      "-ac",
      "1",
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

function isOnPath(command: string): boolean {
  try {
    execFileSync("command", ["-v", command], {
      stdio: "ignore",
      shell: true,
      timeout: 2000,
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
   * The turn's audio is complete. Streaming players drain what is queued;
   * buffered players play the whole turn now.
   */
  finish(): void {
    if (!this.player) {
      return;
    }
    if (this.player.mode === "buffered") {
      this.playBuffered();
      return;
    }
    this.endStream();
  }

  /**
   * Cut playback off immediately and drop anything not yet played. This is
   * barge-in: `turn_cancelled` means the audio still in flight is for a turn
   * that no longer exists, so draining it would be wrong.
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
    });
    // A player that dies mid-turn (or was never really there) must not take
    // the session with it — EPIPE on the next write would be an unhandled
    // error event otherwise.
    child.on("error", () => this.stop());
    child.stdin?.on("error", () => {});
    this.child = child;
    this.activeSampleRate = sampleRate;
  }

  private endStream(): void {
    const child = this.child;
    this.child = null;
    this.activeSampleRate = null;
    // Closing stdin lets the player finish what is already queued and exit on
    // its own; this is the ordinary end of a turn, not an interruption.
    child?.stdin?.end();
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

    const child = spawn(
      this.player.name,
      this.player.args(sampleRate, filePath),
      {
        stdio: "ignore",
      },
    );
    child.on("error", () => {});
    this.child = child;
  }
}

/**
 * Wrap raw PCM16 mono in a 44-byte canonical WAV header.
 *
 * Only for the buffered path — a streaming player is told the format on its
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
