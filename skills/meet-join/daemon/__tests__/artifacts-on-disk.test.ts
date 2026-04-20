/**
 * Integration test for per-meeting artifact files on disk.
 *
 * This test drives a scripted meeting end-to-end through a *real*
 * {@link MeetStorageWriter} backed by the real `node:fs` primitives and,
 * when the host has ffmpeg installed, a real ffmpeg child process that
 * encodes PCM → Opus. Unlike `storage-writer.test.ts` (which mocks spawn
 * and drives unit-level assertions), this test exercises the writer the
 * way the daemon does in production: it writes the full set of five
 * artifacts to a tempdir workspace, then verifies each file exists and is
 * well-formed.
 *
 * Gate: if ffmpeg / ffprobe aren't on PATH we fall back to asserting the
 * Opus container's magic bytes (`OggS`) on the produced file rather than a
 * full ffprobe duration check. The audio path itself is only exercised
 * when `ffmpeg` exists — CI hosts without it skip that block.
 *
 * The test is deliberately decoupled from the shared meet event
 * dispatcher: it uses an in-memory dispatcher shim (identical to the one
 * in `storage-writer.test.ts`) so the writer subscribes to a scoped
 * dispatcher driven by the test, not the process-wide singleton.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { MeetBotEvent, Participant } from "../../contracts/index.js";

import type {
  MeetEventSubscriber,
  MeetEventUnsubscribe,
} from "../event-publisher.js";
import { MeetStorageWriter, type PcmSource } from "../storage-writer.js";

// ---------------------------------------------------------------------------
// Host-tool availability (ffmpeg / ffprobe are optional)
// ---------------------------------------------------------------------------

function hasBinary(name: string): boolean {
  const result = spawnSync("which", [name], { stdio: "ignore" });
  return result.status === 0;
}

const HAS_FFMPEG = hasBinary("ffmpeg");
const HAS_FFPROBE = hasBinary("ffprobe");

/** Opus-in-Ogg container magic bytes: "OggS" at the start of the file. */
const OGG_MAGIC = Buffer.from("OggS", "ascii");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * In-memory dispatcher shim. The writer subscribes to this instead of the
 * process-wide `subscribeToMeetingEvents` so the test has exclusive control
 * over the event stream.
 */
function makeFakeDispatcher(): {
  subscribe: (
    meetingId: string,
    cb: MeetEventSubscriber,
  ) => MeetEventUnsubscribe;
  dispatch: (meetingId: string, event: MeetBotEvent) => void;
} {
  const subs = new Map<string, Set<MeetEventSubscriber>>();
  return {
    subscribe(meetingId, cb) {
      let set = subs.get(meetingId);
      if (!set) {
        set = new Set();
        subs.set(meetingId, set);
      }
      set.add(cb);
      return () => {
        const existing = subs.get(meetingId);
        if (!existing) return;
        existing.delete(cb);
        if (existing.size === 0) subs.delete(meetingId);
      };
    },
    dispatch(meetingId, event) {
      const set = subs.get(meetingId);
      if (!set) return;
      for (const cb of Array.from(set)) cb(event);
    },
  };
}

/** In-memory PCM source driven explicitly by the test. */
function makeTestPcmSource(): {
  source: PcmSource;
  push: (bytes: Uint8Array) => void;
} {
  const cbs = new Set<(bytes: Uint8Array) => void>();
  return {
    source: {
      subscribe(cb) {
        cbs.add(cb);
        return () => {
          cbs.delete(cb);
        };
      },
    },
    push(bytes) {
      for (const cb of cbs) cb(bytes);
    },
  };
}

function participant(id: string, name: string): Participant {
  return { id, name };
}

function transcriptChunk(
  meetingId: string,
  timestamp: string,
  text: string,
  options: {
    isFinal?: boolean;
    speakerId?: string;
    speakerLabel?: string;
  } = {},
): MeetBotEvent {
  return {
    type: "transcript.chunk",
    meetingId,
    timestamp,
    isFinal: options.isFinal ?? true,
    text,
    speakerId: options.speakerId,
    speakerLabel: options.speakerLabel,
  };
}

function speakerChange(
  meetingId: string,
  timestamp: string,
  speakerId: string,
  speakerName: string,
): MeetBotEvent {
  return {
    type: "speaker.change",
    meetingId,
    timestamp,
    speakerId,
    speakerName,
  };
}

function participantChange(
  meetingId: string,
  timestamp: string,
  joined: Participant[],
  left: Participant[] = [],
): MeetBotEvent {
  return {
    type: "participant.change",
    meetingId,
    timestamp,
    joined,
    left,
  };
}

function lifecycleLeft(meetingId: string, timestamp: string): MeetBotEvent {
  return {
    type: "lifecycle",
    meetingId,
    timestamp,
    state: "left",
  };
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "meet-artifacts-e2e-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Meet artifacts on disk (integration)", () => {
  test("writes transcript, segments, participants, and meta files for a scripted session", async () => {
    const meetingId = "m-artifacts-1";
    const dispatcher = makeFakeDispatcher();

    const writer = new MeetStorageWriter(meetingId, {
      getWorkspaceDir: () => workspaceDir,
      subscribe: dispatcher.subscribe,
    });
    writer.start();

    // Scripted event stream: participants join, speaker turns alternate,
    // final transcripts are emitted, then lifecycle:left fires meta.json.
    dispatcher.dispatch(
      meetingId,
      participantChange(meetingId, "2024-05-01T00:00:00.000Z", [
        participant("alice", "Alice"),
        participant("bob", "Bob"),
      ]),
    );
    dispatcher.dispatch(
      meetingId,
      speakerChange(meetingId, "2024-05-01T00:00:01.000Z", "alice", "Alice"),
    );
    dispatcher.dispatch(
      meetingId,
      transcriptChunk(
        meetingId,
        "2024-05-01T00:00:02.000Z",
        "hello from alice",
        { isFinal: true, speakerId: "alice", speakerLabel: "Alice" },
      ),
    );
    dispatcher.dispatch(
      meetingId,
      speakerChange(meetingId, "2024-05-01T00:00:05.000Z", "bob", "Bob"),
    );
    dispatcher.dispatch(
      meetingId,
      transcriptChunk(
        meetingId,
        "2024-05-01T00:00:06.000Z",
        "hi alice this is bob",
        { isFinal: true, speakerId: "bob", speakerLabel: "Bob" },
      ),
    );
    // Interim chunk — should not reach the transcript file.
    dispatcher.dispatch(
      meetingId,
      transcriptChunk(meetingId, "2024-05-01T00:00:07.000Z", "interim junk", {
        isFinal: false,
      }),
    );
    dispatcher.dispatch(
      meetingId,
      lifecycleLeft(meetingId, "2024-05-01T00:00:30.000Z"),
    );

    await writer.stop();

    const baseDir = join(workspaceDir, "meets", meetingId);

    // --- transcript.jsonl ---------------------------------------------------
    const transcriptPath = join(baseDir, "transcript.jsonl");
    expect(existsSync(transcriptPath)).toBe(true);
    const transcriptRaw = readFileSync(transcriptPath, "utf8").trim();
    expect(transcriptRaw.length).toBeGreaterThan(0);
    const transcriptLines = transcriptRaw
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    // Exactly the two final chunks (interim was filtered).
    expect(transcriptLines).toHaveLength(2);
    for (const line of transcriptLines) {
      expect(typeof line.timestamp).toBe("string");
      expect(typeof line.text).toBe("string");
    }
    expect(transcriptLines[0].text).toBe("hello from alice");
    expect(transcriptLines[1].text).toBe("hi alice this is bob");

    // --- segments.jsonl -----------------------------------------------------
    const segmentsPath = join(baseDir, "segments.jsonl");
    expect(existsSync(segmentsPath)).toBe(true);
    const segmentsRaw = readFileSync(segmentsPath, "utf8").trim();
    expect(segmentsRaw.length).toBeGreaterThan(0);
    const segmentLines = segmentsRaw
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    // Two segments: Alice's span closed on Bob's speaker.change, Bob's span
    // closed on lifecycle:left.
    expect(segmentLines).toHaveLength(2);
    for (const line of segmentLines) {
      expect(typeof line.start).toBe("string");
      expect(typeof line.end).toBe("string");
      expect(typeof line.speakerId).toBe("string");
    }
    expect(segmentLines[0].speakerId).toBe("alice");
    expect(segmentLines[1].speakerId).toBe("bob");

    // --- participants.json --------------------------------------------------
    const participantsPath = join(baseDir, "participants.json");
    expect(existsSync(participantsPath)).toBe(true);
    const participants = JSON.parse(
      readFileSync(participantsPath, "utf8"),
    ) as Array<{ id: string; name: string }>;
    expect(Array.isArray(participants)).toBe(true);
    expect(participants).toHaveLength(2);
    const ids = participants.map((p) => p.id).sort();
    expect(ids).toEqual(["alice", "bob"]);

    // --- meta.json ----------------------------------------------------------
    const metaPath = join(baseDir, "meta.json");
    expect(existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(meta.meetingId).toBe(meetingId);
    expect(typeof meta.startedAt).toBe("string");
    expect(typeof meta.endedAt).toBe("string");
    expect(meta.endedAt).toBe("2024-05-01T00:00:30.000Z");
    expect(meta.participantCount).toBe(2);
    expect(meta.totalTranscriptChars).toBe(
      "hello from alice".length + "hi alice this is bob".length,
    );
  });

  test.skipIf(!HAS_FFMPEG)(
    "writes a well-formed audio.opus when ffmpeg is available",
    async () => {
      const meetingId = "m-artifacts-audio";
      const dispatcher = makeFakeDispatcher();
      const pcm = makeTestPcmSource();

      const writer = new MeetStorageWriter(meetingId, {
        getWorkspaceDir: () => workspaceDir,
        subscribe: dispatcher.subscribe,
      });
      writer.start();
      await writer.startAudio(pcm.source);

      // Drive ~1s of silent PCM (s16le @ 16kHz mono = 32 000 bytes/sec).
      // A single 32KB silent buffer yields enough frames for ffmpeg to
      // produce a non-empty Opus file with a measurable duration.
      const SAMPLE_RATE = 16_000;
      const BYTES_PER_SAMPLE = 2;
      const SECONDS = 1;
      const silent = new Uint8Array(SAMPLE_RATE * BYTES_PER_SAMPLE * SECONDS);
      // Push in a few chunks to simulate streaming.
      const CHUNK = 4096;
      for (let offset = 0; offset < silent.length; offset += CHUNK) {
        pcm.push(
          silent.subarray(offset, Math.min(offset + CHUNK, silent.length)),
        );
      }

      // Emit lifecycle:left — this closes ffmpeg's stdin, which causes
      // ffmpeg to finalize the Ogg/Opus container and exit cleanly.
      dispatcher.dispatch(
        meetingId,
        lifecycleLeft(meetingId, "2024-05-01T00:00:30.000Z"),
      );

      // Wait for the ffmpeg child spawned inside the writer to finish
      // flushing + closing the Opus file. stop() does not await the exit
      // by design (it just ends stdin), so we poll for the file to appear
      // at a stable non-zero size.
      await writer.stop();

      const audioPath = join(workspaceDir, "meets", meetingId, "audio.opus");
      await waitForStableFile(audioPath, { timeoutMs: 10_000 });

      expect(existsSync(audioPath)).toBe(true);
      const size = statSync(audioPath).size;
      expect(size).toBeGreaterThan(0);

      // Magic-byte check (cheap, always applicable).
      const header = readFileSync(audioPath).subarray(0, 4);
      expect(header.equals(OGG_MAGIC)).toBe(true);

      // Duration check via ffprobe, when available. ffprobe reports the
      // duration in seconds as a float; any positive value confirms the
      // file is a playable Opus stream, not just a stray header.
      if (HAS_FFPROBE) {
        const out = execFileSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            audioPath,
          ],
          { encoding: "utf8" },
        ).trim();
        const duration = Number.parseFloat(out);
        expect(Number.isFinite(duration)).toBe(true);
        expect(duration).toBeGreaterThan(0);
      }
    },
  );

  test("tempdir cleanup removes the workspace directory after a session", async () => {
    const meetingId = "m-artifacts-cleanup";
    const dispatcher = makeFakeDispatcher();

    const writer = new MeetStorageWriter(meetingId, {
      getWorkspaceDir: () => workspaceDir,
      subscribe: dispatcher.subscribe,
    });
    writer.start();
    dispatcher.dispatch(
      meetingId,
      participantChange(meetingId, "2024-05-01T00:00:00.000Z", [
        participant("x", "Xavier"),
      ]),
    );
    dispatcher.dispatch(
      meetingId,
      lifecycleLeft(meetingId, "2024-05-01T00:00:01.000Z"),
    );
    await writer.stop();

    // Sanity: the session wrote at least one artifact into the tempdir.
    expect(existsSync(join(workspaceDir, "meets", meetingId))).toBe(true);

    // Now simulate afterEach's cleanup manually and confirm the directory
    // is gone. The real afterEach will also run; `rmSync` with `force: true`
    // is idempotent so double-removal is safe.
    rmSync(workspaceDir, { recursive: true, force: true });
    expect(existsSync(workspaceDir)).toBe(false);
  });
});

/**
 * Wait until a file exists and its size has stopped changing between two
 * consecutive samples, which means the writing process has finished
 * flushing. We don't have a direct handle on the ffmpeg child's exit, so
 * this poll-based approach is the cleanest way to bound the wait.
 */
async function waitForStableFile(
  path: string,
  opts: { timeoutMs: number; pollIntervalMs?: number } = { timeoutMs: 5000 },
): Promise<void> {
  const pollInterval = opts.pollIntervalMs ?? 100;
  const deadline = Date.now() + opts.timeoutMs;
  let prevSize = -1;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const size = statSync(path).size;
      if (size > 0 && size === prevSize) return;
      prevSize = size;
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
  throw new Error(
    `waitForStableFile: ${path} did not stabilize within ${opts.timeoutMs}ms`,
  );
}
