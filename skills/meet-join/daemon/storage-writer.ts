/**
 * MeetStorageWriter — per-meeting artifact writer.
 *
 * Materializes persistent artifacts for a meet-bot session into
 * `<workspace>/meets/<meetingId>/`. The storage layout is:
 *
 *   audio.opus         — Opus-encoded audio written by a child ffmpeg that
 *                        receives s16le@16kHz mono PCM on its stdin.
 *   segments.jsonl     — One JSON line per DOM-reported speaker span. A span
 *                        opens on a `speaker.change` event and is closed at
 *                        the next `speaker.change` (or on session end).
 *   transcript.jsonl   — One JSON line per *final* transcript chunk. Interim
 *                        ASR chunks are ignored — only stable text is kept.
 *   participants.json  — Full latest snapshot of participants (NOT a diff).
 *                        Rewritten in full on each `participant.change`.
 *   meta.json          — Summary record written when the session reaches
 *                        lifecycle state "left".
 *
 * Append writes to segments/transcript use append mode and are explicitly
 * fsync'd on meaningful boundaries (5s cadence or every 100 writes) so a
 * daemon crash/kill doesn't silently lose just-emitted data.
 *
 * Dependency-injection hooks let tests substitute `spawn` (for ffmpeg) and
 * the underlying fs primitives so the test suite doesn't need ffmpeg
 * installed and can run against a tempdir workspace.
 *
 * Subscribes via {@link subscribeToMeetingEvents} on the meet event
 * dispatcher — this lets the writer coexist with the conversation
 * bridge, event-hub publisher, and consent monitor as peer subscribers
 * on the same per-meeting event stream. Callers are
 * responsible for driving `startAudio` (when a PCM source is available)
 * and `stop` on session teardown — the writer itself tears down its
 * dispatcher subscription and the ffmpeg child when `stop` is invoked, and
 * also closes the ffmpeg child on `lifecycle:left`.
 */

import {
  type ChildProcessWithoutNullStreams,
  spawn as nodeSpawn,
} from "node:child_process";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import type { Logger, SkillHost } from "@vellumai/skill-host-contracts";

import type {
  MeetBotEvent,
  Participant,
  ParticipantChangeEvent,
  SpeakerChangeEvent,
  TranscriptChunkEvent,
} from "../contracts/index.js";

import {
  type MeetEventSubscriber,
  type MeetEventUnsubscribe,
  subscribeToMeetingEvents,
} from "./event-publisher.js";
import { registerSubModule } from "./modules-registry.js";

/**
 * Fallback logger for tests / direct `new MeetStorageWriter(...)` calls that
 * omit the host-sourced logger. Keeps every production caller host-wired
 * without forcing unit tests to build a full {@link SkillHost} stub.
 */
const consoleLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (msg, meta) => {
    // eslint-disable-next-line no-console
    console.warn(msg, meta ?? {});
  },
  error: (msg, meta) => {
    // eslint-disable-next-line no-console
    console.error(msg, meta ?? {});
  },
};

// ---------------------------------------------------------------------------
// Tuning knobs
// ---------------------------------------------------------------------------

/** Flush cadence: force fsync at most every N milliseconds. */
export const FSYNC_INTERVAL_MS = 5_000;

/** Flush cadence: force fsync after N writes since the last flush. */
export const FSYNC_WRITE_THRESHOLD = 100;

/**
 * ffmpeg arguments that encode the raw s16le@16kHz mono PCM stream flowing
 * in on stdin to a 48 kbps Opus file at `<meetingDir>/audio.opus`. `-y`
 * overwrites an existing file — the previous session for this meeting
 * shouldn't be pre-existing, but keep it explicit for idempotency.
 */
export const FFMPEG_AUDIO_ARGS = [
  "-f",
  "s16le",
  "-ar",
  "16000",
  "-ac",
  "1",
  "-i",
  "pipe:0",
  "-c:a",
  "libopus",
  "-b:a",
  "48k",
  "-y",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Audio source that emits raw s16le@16kHz mono PCM chunks. The source
 * provider registers a callback via `subscribe` and returns an unsubscribe
 * function the writer invokes on stop.
 */
export interface PcmSource {
  subscribe(cb: (bytes: Uint8Array) => void): () => void;
}

/** Spawn primitive — `node:child_process#spawn` by default; swappable in tests. */
export type SpawnFn = typeof nodeSpawn;

/** fs primitives the writer relies on. All swappable in tests. */
export interface FsPrimitives {
  mkdirSync: typeof mkdirSync;
  openSync: typeof openSync;
  writeSync: typeof writeSync;
  closeSync: typeof closeSync;
  fsyncSync: typeof fsyncSync;
  writeFileSync: typeof writeFileSync;
}

export interface MeetStorageWriterDeps {
  /**
   * Resolve the workspace directory. Tests pass a tempdir; production
   * callers construct the writer via {@link createStorageWriter} which
   * wires this to `host.platform.workspaceDir()`.
   */
  getWorkspaceDir?: () => string;
  /** Override the `spawn` used to launch ffmpeg (tests). */
  spawn?: SpawnFn;
  /** Override fs primitives (tests). */
  fs?: Partial<FsPrimitives>;
  /** Override monotonic clock used for flush scheduling (tests). */
  now?: () => number;
  /**
   * Override the dispatcher subscribe function (tests). Defaults to
   * {@link subscribeToMeetingEvents} on the process-wide meet event
   * dispatcher so the writer coexists with other per-meeting subscribers.
   */
  subscribe?: (
    meetingId: string,
    cb: MeetEventSubscriber,
  ) => MeetEventUnsubscribe;
  /**
   * Logger used for best-effort I/O telemetry. Defaults to a console-
   * backed fallback so unit tests that construct the writer directly
   * don't need to supply one. Production callers wire
   * `host.logger.get("meet-storage-writer")` via
   * {@link createStorageWriter}.
   */
  logger?: Logger;
}

/**
 * Shape of a span in `segments.jsonl`. `end` is null while a span is open
 * (reserved for potential streaming consumers) and concrete by the time the
 * line is flushed.
 */
interface SegmentLine {
  start: string;
  end: string;
  speakerId: string;
  speakerName: string;
}

interface OpenSegment {
  start: string;
  speakerId: string;
  speakerName: string;
}

interface AppendFdState {
  fd: number;
  writesSinceFlush: number;
  lastFlushAtMs: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_FS: FsPrimitives = {
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  fsyncSync,
  writeFileSync,
};

export class MeetStorageWriter {
  readonly meetingId: string;
  readonly meetingDir: string;

  private readonly deps: Required<MeetStorageWriterDeps>;
  private readonly fs: FsPrimitives;
  private readonly log: Logger;

  private segmentsFd: AppendFdState | null = null;
  private transcriptFd: AppendFdState | null = null;

  private openSegment: OpenSegment | null = null;
  private participants: Participant[] = [];
  private totalTranscriptChars = 0;
  private startedAt: string | null = null;
  private endedAt: string | null = null;

  private ffmpegChild: ChildProcessWithoutNullStreams | null = null;
  private pcmUnsubscribe: (() => void) | null = null;

  private eventUnsubscribe: MeetEventUnsubscribe | null = null;

  private stopped = false;

  constructor(meetingId: string, deps: MeetStorageWriterDeps = {}) {
    if (!meetingId) {
      throw new Error("MeetStorageWriter: meetingId is required");
    }
    // No ambient workspace fallback — callers must provide a resolver.
    // Production wiring comes from {@link createStorageWriter} via
    // `host.platform.workspaceDir()`; tests/tooling inject a tempdir.
    const resolveWorkspaceDir = deps.getWorkspaceDir;
    if (!resolveWorkspaceDir) {
      throw new Error(
        "MeetStorageWriter: deps.getWorkspaceDir is required — construct via createStorageWriter(host) or pass an explicit resolver",
      );
    }
    this.meetingId = meetingId;
    this.deps = {
      getWorkspaceDir: resolveWorkspaceDir,
      spawn: deps.spawn ?? nodeSpawn,
      fs: deps.fs ?? {},
      now: deps.now ?? Date.now,
      subscribe: deps.subscribe ?? subscribeToMeetingEvents,
      logger: deps.logger ?? consoleLogger,
    };
    this.fs = { ...DEFAULT_FS, ...(deps.fs ?? {}) };
    this.log = this.deps.logger;
    this.meetingDir = join(
      this.deps.getWorkspaceDir(),
      "meets",
      this.meetingId,
    );
  }

  /**
   * Subscribe to the per-meeting event dispatcher. Idempotent. Callers
   * should invoke this once, immediately after construction, so the writer
   * catches the very first events of the session.
   */
  start(): void {
    if (this.eventUnsubscribe) return;
    this.ensureMeetingDir();
    if (!this.startedAt) this.startedAt = new Date().toISOString();
    this.eventUnsubscribe = this.deps.subscribe(this.meetingId, (event) =>
      this.onEvent(event),
    );
  }

  /**
   * Start encoding audio. Spawns ffmpeg (s16le → Opus) and pipes PCM
   * callbacks from `pcmSource` into its stdin. Safe to call multiple times;
   * subsequent calls are no-ops after the first successful spawn.
   */
  async startAudio(pcmSource: PcmSource): Promise<void> {
    if (this.stopped) {
      throw new Error("MeetStorageWriter: cannot startAudio after stop()");
    }
    if (this.ffmpegChild) return;

    this.ensureMeetingDir();

    const audioPath = join(this.meetingDir, "audio.opus");
    const args = [...FFMPEG_AUDIO_ARGS, audioPath];

    const child = this.deps.spawn("ffmpeg", args, {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    child.on("error", (err) => {
      this.log.error("ffmpeg spawn/runtime error", {
        err,
        meetingId: this.meetingId,
      });
    });
    child.on("exit", (code, signal) => {
      this.log.info("ffmpeg exited", {
        meetingId: this.meetingId,
        code,
        signal,
      });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.log.debug("ffmpeg stderr", {
        meetingId: this.meetingId,
        stderr: chunk.toString("utf8"),
      });
    });
    child.stdin.on("error", (err) => {
      this.log.debug("ffmpeg stdin error (suppressed)", {
        err,
        meetingId: this.meetingId,
      });
    });

    this.ffmpegChild = child;

    this.pcmUnsubscribe = pcmSource.subscribe((bytes) => {
      this.writeAudio(bytes);
    });
  }

  /**
   * Flush buffers, close open segment, unsubscribe from the dispatcher,
   * and close the ffmpeg child. Idempotent: subsequent calls are no-ops.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;

    // Perform fallible I/O cleanup before setting stopped=true so that if
    // this throws, a retry call to stop() won't short-circuit and leak
    // resources.
    this.closeOpenSegmentAt(new Date().toISOString());

    this.stopped = true;

    if (this.eventUnsubscribe) {
      try {
        this.eventUnsubscribe();
      } catch (err) {
        this.log.warn("dispatcher unsubscribe threw during stop", {
          err,
          meetingId: this.meetingId,
        });
      }
      this.eventUnsubscribe = null;
    }

    this.flushAndCloseFd(this.segmentsFd);
    this.segmentsFd = null;
    this.flushAndCloseFd(this.transcriptFd);
    this.transcriptFd = null;

    if (this.pcmUnsubscribe) {
      try {
        this.pcmUnsubscribe();
      } catch (err) {
        this.log.warn("pcm unsubscribe threw during stop", {
          err,
          meetingId: this.meetingId,
        });
      }
      this.pcmUnsubscribe = null;
    }

    const child = this.ffmpegChild;
    if (child) {
      this.ffmpegChild = null;
      try {
        child.stdin?.end();
      } catch (err) {
        this.log.warn("ffmpeg stdin close threw during stop", {
          err,
          meetingId: this.meetingId,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Event handling
  // -------------------------------------------------------------------------

  private onEvent(event: MeetBotEvent): void {
    if (this.stopped) return;
    try {
      switch (event.type) {
        case "transcript.chunk":
          this.onTranscriptChunk(event);
          break;
        case "speaker.change":
          this.onSpeakerChange(event);
          break;
        case "participant.change":
          this.onParticipantChange(event);
          break;
        case "lifecycle":
          if (event.state === "left") {
            this.endedAt = event.timestamp;
            this.closeOpenSegmentAt(event.timestamp);
            this.writeMetaJson();
            this.closeFfmpegStdin();
          }
          break;
        // chat.inbound is handled by the conversation bridge. Drop silently.
        default:
          break;
      }
    } catch (err) {
      this.log.error("MeetStorageWriter: handler threw", {
        err,
        meetingId: this.meetingId,
        eventType: event.type,
      });
    }
  }

  private onTranscriptChunk(event: TranscriptChunkEvent): void {
    if (!event.isFinal) return;
    const line: Record<string, unknown> = {
      timestamp: event.timestamp,
      text: event.text,
    };
    if (event.speakerId !== undefined) line.speakerId = event.speakerId;
    if (event.speakerLabel !== undefined)
      line.speakerLabel = event.speakerLabel;
    if (event.confidence !== undefined) line.confidence = event.confidence;
    this.appendJsonl("transcript", line);
    this.totalTranscriptChars += event.text.length;
  }

  private onSpeakerChange(event: SpeakerChangeEvent): void {
    // Close the previous span at this event's timestamp, then open a new
    // one starting now. Back-to-back speaker.change events for the same
    // speaker still produce a closed+opened pair — the source of truth for
    // speaker spans is the sequence of events we receive.
    this.closeOpenSegmentAt(event.timestamp);
    this.openSegment = {
      start: event.timestamp,
      speakerId: event.speakerId,
      speakerName: event.speakerName,
    };
  }

  private onParticipantChange(event: ParticipantChangeEvent): void {
    // Maintain a running snapshot and rewrite the file in full on each
    // change. We prefer the explicit `joined`/`left` arrays over a naive
    // full-replacement so id-stable updates (name changes, host flag
    // transitions) don't duplicate entries.
    const byId = new Map<string, Participant>(
      this.participants.map((p) => [p.id, p]),
    );
    for (const p of event.joined) byId.set(p.id, p);
    for (const p of event.left) byId.delete(p.id);
    this.participants = Array.from(byId.values());
    this.writeParticipantsJson();
  }

  // -------------------------------------------------------------------------
  // File writing
  // -------------------------------------------------------------------------

  private ensureMeetingDir(): void {
    this.fs.mkdirSync(this.meetingDir, { recursive: true });
  }

  private openAppendFd(name: string): AppendFdState {
    this.ensureMeetingDir();
    const path = join(this.meetingDir, name);
    // 'a' = O_APPEND|O_CREAT|O_WRONLY — atomic append relative to other
    // writers on the same fd/file (single-process in our case).
    const fd = this.fs.openSync(path, "a");
    return { fd, writesSinceFlush: 0, lastFlushAtMs: this.deps.now() };
  }

  private appendJsonl(
    kind: "segments" | "transcript",
    line: Record<string, unknown>,
  ): void {
    const filename =
      kind === "segments" ? "segments.jsonl" : "transcript.jsonl";
    const state =
      kind === "segments"
        ? (this.segmentsFd ??= this.openAppendFd(filename))
        : (this.transcriptFd ??= this.openAppendFd(filename));

    const data = Buffer.from(JSON.stringify(line) + "\n", "utf8");
    this.fs.writeSync(state.fd, data);
    state.writesSinceFlush += 1;
    this.maybeFlush(state);
  }

  private maybeFlush(state: AppendFdState): void {
    const now = this.deps.now();
    if (
      state.writesSinceFlush >= FSYNC_WRITE_THRESHOLD ||
      now - state.lastFlushAtMs >= FSYNC_INTERVAL_MS
    ) {
      try {
        this.fs.fsyncSync(state.fd);
      } catch (err) {
        this.log.warn("fsync failed (non-fatal)", {
          err,
          meetingId: this.meetingId,
        });
      }
      state.writesSinceFlush = 0;
      state.lastFlushAtMs = now;
    }
  }

  private flushAndCloseFd(state: AppendFdState | null): void {
    if (!state) return;
    try {
      this.fs.fsyncSync(state.fd);
    } catch (err) {
      this.log.warn("final fsync failed (non-fatal)", {
        err,
        meetingId: this.meetingId,
      });
    }
    try {
      this.fs.closeSync(state.fd);
    } catch (err) {
      this.log.warn("fd close failed (non-fatal)", {
        err,
        meetingId: this.meetingId,
      });
    }
  }

  private closeOpenSegmentAt(endTimestamp: string): void {
    const open = this.openSegment;
    if (!open) return;
    const line: SegmentLine = {
      start: open.start,
      end: endTimestamp,
      speakerId: open.speakerId,
      speakerName: open.speakerName,
    };
    this.appendJsonl("segments", line as unknown as Record<string, unknown>);
    this.openSegment = null;
  }

  private writeParticipantsJson(): void {
    this.ensureMeetingDir();
    const path = join(this.meetingDir, "participants.json");
    // Overwrite with the full current list. atomic-rename is overkill here:
    // the file is written via a single writeFileSync call, and a partial
    // write at the OS level only drops the tail of a small JSON blob.
    this.fs.writeFileSync(
      path,
      JSON.stringify(this.participants, null, 2) + "\n",
      "utf8",
    );
  }

  private writeMetaJson(): void {
    this.ensureMeetingDir();
    const path = join(this.meetingDir, "meta.json");
    const meta = {
      meetingId: this.meetingId,
      startedAt: this.startedAt ?? new Date().toISOString(),
      endedAt: this.endedAt ?? new Date().toISOString(),
      participantCount: this.participants.length,
      totalTranscriptChars: this.totalTranscriptChars,
    };
    this.fs.writeFileSync(path, JSON.stringify(meta, null, 2) + "\n", "utf8");
  }

  // -------------------------------------------------------------------------
  // Audio
  // -------------------------------------------------------------------------

  private writeAudio(bytes: Uint8Array): void {
    const child = this.ffmpegChild;
    if (!child) return;
    try {
      child.stdin.write(Buffer.from(bytes));
    } catch (err) {
      this.log.warn("ffmpeg stdin write failed", {
        err,
        meetingId: this.meetingId,
      });
    }
  }

  private closeFfmpegStdin(): void {
    const child = this.ffmpegChild;
    if (!child) return;
    this.ffmpegChild = null;
    try {
      child.stdin?.end();
    } catch (err) {
      this.log.warn("ffmpeg stdin end failed", {
        err,
        meetingId: this.meetingId,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Host-based factory
// ---------------------------------------------------------------------------

/**
 * Build a callable that creates per-meeting {@link MeetStorageWriter}
 * instances bound to a {@link SkillHost}. Returning a factory (rather
 * than a single writer) matches how the session manager spins up one
 * writer per active meeting — all sharing the same host-scoped logger
 * and workspace-path resolution.
 *
 * Registered under the sub-module slot `"storage-writer"` in
 * {@link registerSubModule} at module import time; the session
 * manager consumes the registration via `getSubModule`.
 */
export function createStorageWriter(
  host: SkillHost,
): (meetingId: string, overrides?: MeetStorageWriterDeps) => MeetStorageWriter {
  const logger = host.logger.get("meet-storage-writer");
  return (meetingId, overrides = {}) =>
    new MeetStorageWriter(meetingId, {
      getWorkspaceDir: () => host.platform.workspaceDir(),
      logger,
      ...overrides,
    });
}

registerSubModule("storage-writer", createStorageWriter);
