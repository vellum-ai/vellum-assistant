/**
 * Unit tests for {@link MeetStorageWriter}.
 *
 * These tests run against a tempdir workspace, bypass the real ffmpeg by
 * injecting a mock `spawn` that records bytes piped into the spawned
 * child's stdin, and drive the writer by injecting a fake dispatcher
 * subscription. The writer uses {@link subscribeToMeetingEvents} in
 * production; tests replace that with an in-memory shim that records
 * subscribers per meeting and lets the test dispatch events directly.
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { MeetBotEvent, Participant } from "@vellumai/meet-contracts";

import type {
  MeetEventSubscriber,
  MeetEventUnsubscribe,
} from "../event-publisher.js";
import {
  FSYNC_INTERVAL_MS,
  FSYNC_WRITE_THRESHOLD,
  MeetStorageWriter,
  type PcmSource,
} from "../storage-writer.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface MockFfmpegChild extends EventEmitter {
  stdin: {
    write: (chunk: Buffer) => boolean;
    end: () => void;
    chunks: Buffer[];
    ended: boolean;
  };
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function makeMockFfmpegChild(): MockFfmpegChild {
  const emitter = new EventEmitter() as MockFfmpegChild;
  const chunks: Buffer[] = [];
  emitter.stdin = {
    chunks,
    ended: false,
    write(chunk: Buffer): boolean {
      chunks.push(chunk);
      return true;
    },
    end(): void {
      this.ended = true;
    },
  };
  emitter.stdout = new EventEmitter();
  emitter.stderr = new EventEmitter();
  return emitter;
}

function makeSpawnMock(): {
  spawn: ReturnType<typeof mock>;
  lastChild: () => MockFfmpegChild | null;
  calls: () => Array<{ cmd: string; args: readonly string[] }>;
} {
  let child: MockFfmpegChild | null = null;
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const spawn = mock((cmd: string, args: readonly string[]) => {
    calls.push({ cmd, args: [...args] });
    child = makeMockFfmpegChild();
    return child as unknown as ReturnType<
      typeof import("node:child_process").spawn
    >;
  });
  return {
    spawn,
    lastChild: () => child,
    calls: () => calls,
  };
}

function makeTestPcmSource(): {
  source: PcmSource;
  push: (bytes: Uint8Array) => void;
  subscribers: number;
} {
  const cbs = new Set<(bytes: Uint8Array) => void>();
  const state = {
    source: {
      subscribe(cb: (bytes: Uint8Array) => void): () => void {
        cbs.add(cb);
        return () => {
          cbs.delete(cb);
        };
      },
    } as PcmSource,
    push(bytes: Uint8Array): void {
      for (const cb of cbs) cb(bytes);
    },
    get subscribers(): number {
      return cbs.size;
    },
  };
  return state;
}

/**
 * In-memory replacement for {@link subscribeToMeetingEvents}. Matches the
 * dispatcher surface the writer depends on — multiple subscribers per
 * meeting, independent unsubscribe handles — so tests can drive the writer
 * without touching the real singleton dispatcher.
 */
function makeFakeDispatcher(): {
  subscribe: (
    meetingId: string,
    cb: MeetEventSubscriber,
  ) => MeetEventUnsubscribe;
  dispatch: (meetingId: string, event: MeetBotEvent) => void;
  subscriberCount: (meetingId: string) => number;
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
    subscriberCount(meetingId) {
      return subs.get(meetingId)?.size ?? 0;
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

function readJsonlLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "meet-storage-writer-test-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MeetStorageWriter.start / dispatcher subscription", () => {
  test("start() creates the meeting dir and subscribes on the dispatcher", () => {
    const dispatcher = makeFakeDispatcher();
    const writer = new MeetStorageWriter("m1", {
      getWorkspaceDir: () => workspaceDir,
      subscribe: dispatcher.subscribe,
    });
    writer.start();

    expect(existsSync(join(workspaceDir, "meets", "m1"))).toBe(true);
    expect(dispatcher.subscriberCount("m1")).toBe(1);
  });

  test("start() is idempotent", () => {
    const dispatcher = makeFakeDispatcher();
    const writer = new MeetStorageWriter("m1", {
      getWorkspaceDir: () => workspaceDir,
      subscribe: dispatcher.subscribe,
    });
    writer.start();
    writer.start();
    expect(dispatcher.subscriberCount("m1")).toBe(1);
  });

  test("stop() unsubscribes from the dispatcher", async () => {
    const dispatcher = makeFakeDispatcher();
    const writer = new MeetStorageWriter("m1", {
      getWorkspaceDir: () => workspaceDir,
      subscribe: dispatcher.subscribe,
    });
    writer.start();
    expect(dispatcher.subscriberCount("m1")).toBe(1);
    await writer.stop();
    expect(dispatcher.subscriberCount("m1")).toBe(0);
  });

  test("coexists with other dispatcher subscribers", async () => {
    const dispatcher = makeFakeDispatcher();
    const other = mock((_event: MeetBotEvent) => {});
    const otherUnsub = dispatcher.subscribe("m1", other);

    const writer = new MeetStorageWriter("m1", {
      getWorkspaceDir: () => workspaceDir,
      subscribe: dispatcher.subscribe,
    });
    writer.start();
    expect(dispatcher.subscriberCount("m1")).toBe(2);

    dispatcher.dispatch(
      "m1",
      transcriptChunk("m1", "2024-01-01T00:00:00.000Z", "hello world", {
        isFinal: true,
      }),
    );

    // Both subscribers saw the event.
    expect(other).toHaveBeenCalledTimes(1);

    await writer.stop();
    // The peer subscriber's slot survives the writer's unsubscribe.
    expect(dispatcher.subscriberCount("m1")).toBe(1);
    otherUnsub();
  });
});

describe("MeetStorageWriter transcript.jsonl", () => {
  test("appends final transcript chunks and ignores interim", async () => {
    const dispatcher = makeFakeDispatcher();
    const writer = new MeetStorageWriter("m1", {
      getWorkspaceDir: () => workspaceDir,
      subscribe: dispatcher.subscribe,
    });
    writer.start();

    dispatcher.dispatch(
      "m1",
      transcriptChunk("m1", "2024-01-01T00:00:00.000Z", "hello", {
        isFinal: false,
      }),
    );
    dispatcher.dispatch(
      "m1",
      transcriptChunk("m1", "2024-01-01T00:00:01.000Z", "hello world", {
        isFinal: true,
        speakerId: "s1",
        speakerLabel: "Alice",
      }),
    );
    dispatcher.dispatch(
      "m1",
      transcriptChunk("m1", "2024-01-01T00:00:02.000Z", "second final", {
        isFinal: true,
      }),
    );

    await writer.stop();

    const lines = readJsonlLines(
      join(workspaceDir, "meets", "m1", "transcript.jsonl"),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      timestamp: "2024-01-01T00:00:01.000Z",
      text: "hello world",
      speakerId: "s1",
      speakerLabel: "Alice",
    });
    expect(lines[1]).toEqual({
      timestamp: "2024-01-01T00:00:02.000Z",
      text: "second final",
    });
  });
});

describe("MeetStorageWriter segments.jsonl", () => {
  test("closes previous segment at each new speaker.change", async () => {
    const dispatcher = makeFakeDispatcher();
    const writer = new MeetStorageWriter("m1", {
      getWorkspaceDir: () => workspaceDir,
      subscribe: dispatcher.subscribe,
    });
    writer.start();

    dispatcher.dispatch(
      "m1",
      speakerChange("m1", "2024-01-01T00:00:00.000Z", "s1", "Alice"),
    );
    dispatcher.dispatch(
      "m1",
      speakerChange("m1", "2024-01-01T00:00:05.000Z", "s2", "Bob"),
    );
    dispatcher.dispatch(
      "m1",
      speakerChange("m1", "2024-01-01T00:00:12.000Z", "s1", "Alice"),
    );
    dispatcher.dispatch("m1", lifecycleLeft("m1", "2024-01-01T00:00:20.000Z"));

    await writer.stop();

    const lines = readJsonlLines(
      join(workspaceDir, "meets", "m1", "segments.jsonl"),
    );
    expect(lines).toEqual([
      {
        start: "2024-01-01T00:00:00.000Z",
        end: "2024-01-01T00:00:05.000Z",
        speakerId: "s1",
        speakerName: "Alice",
      },
      {
        start: "2024-01-01T00:00:05.000Z",
        end: "2024-01-01T00:00:12.000Z",
        speakerId: "s2",
        speakerName: "Bob",
      },
      {
        start: "2024-01-01T00:00:12.000Z",
        end: "2024-01-01T00:00:20.000Z",
        speakerId: "s1",
        speakerName: "Alice",
      },
    ]);
  });

  test("open span on stop() is closed at stop timestamp", async () => {
    const dispatcher = makeFakeDispatcher();
    const writer = new MeetStorageWriter("m1", {
      getWorkspaceDir: () => workspaceDir,
      subscribe: dispatcher.subscribe,
    });
    writer.start();

    dispatcher.dispatch(
      "m1",
      speakerChange("m1", "2024-01-01T00:00:00.000Z", "s1", "Alice"),
    );

    await writer.stop();

    const lines = readJsonlLines(
      join(workspaceDir, "meets", "m1", "segments.jsonl"),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].start).toBe("2024-01-01T00:00:00.000Z");
    expect(typeof lines[0].end).toBe("string");
    expect(lines[0].speakerId).toBe("s1");
  });
});

describe("MeetStorageWriter participants.json", () => {
  test("overwrites with the latest full list (not a diff)", async () => {
    const dispatcher = makeFakeDispatcher();
    const writer = new MeetStorageWriter("m1", {
      getWorkspaceDir: () => workspaceDir,
      subscribe: dispatcher.subscribe,
    });
    writer.start();

    dispatcher.dispatch(
      "m1",
      participantChange("m1", "2024-01-01T00:00:00.000Z", [
        participant("a", "Alice"),
        participant("b", "Bob"),
      ]),
    );

    const afterFirst = JSON.parse(
      readFileSync(
        join(workspaceDir, "meets", "m1", "participants.json"),
        "utf8",
      ),
    );
    expect(afterFirst).toEqual([
      { id: "a", name: "Alice" },
      { id: "b", name: "Bob" },
    ]);

    dispatcher.dispatch(
      "m1",
      participantChange(
        "m1",
        "2024-01-01T00:00:05.000Z",
        [participant("c", "Carol")],
        [participant("a", "Alice")],
      ),
    );

    const afterSecond = JSON.parse(
      readFileSync(
        join(workspaceDir, "meets", "m1", "participants.json"),
        "utf8",
      ),
    );
    // Full snapshot: Bob remains, Alice was removed, Carol was added.
    expect(afterSecond).toEqual([
      { id: "b", name: "Bob" },
      { id: "c", name: "Carol" },
    ]);

    await writer.stop();
  });
});

describe("MeetStorageWriter meta.json", () => {
  test("lifecycle:left writes meta.json with aggregate counters", async () => {
    const dispatcher = makeFakeDispatcher();
    const writer = new MeetStorageWriter("m1", {
      getWorkspaceDir: () => workspaceDir,
      subscribe: dispatcher.subscribe,
    });
    writer.start();

    dispatcher.dispatch(
      "m1",
      participantChange("m1", "2024-01-01T00:00:00.000Z", [
        participant("a", "Alice"),
        participant("b", "Bob"),
      ]),
    );
    dispatcher.dispatch(
      "m1",
      transcriptChunk("m1", "2024-01-01T00:00:01.000Z", "hello", {
        isFinal: true,
      }),
    );
    dispatcher.dispatch(
      "m1",
      transcriptChunk("m1", "2024-01-01T00:00:02.000Z", "world!!", {
        isFinal: true,
      }),
    );
    dispatcher.dispatch("m1", lifecycleLeft("m1", "2024-01-01T00:00:30.000Z"));

    // meta.json is written on lifecycle:left, not stop()
    const meta = JSON.parse(
      readFileSync(join(workspaceDir, "meets", "m1", "meta.json"), "utf8"),
    );
    expect(meta.meetingId).toBe("m1");
    expect(meta.participantCount).toBe(2);
    expect(meta.totalTranscriptChars).toBe("hello".length + "world!!".length);
    expect(meta.endedAt).toBe("2024-01-01T00:00:30.000Z");
    expect(typeof meta.startedAt).toBe("string");

    await writer.stop();
  });
});

describe("MeetStorageWriter audio pipeline (mocked spawn)", () => {
  test("startAudio spawns ffmpeg with expected args and pipes PCM bytes", async () => {
    const dispatcher = makeFakeDispatcher();
    const { spawn, lastChild, calls } = makeSpawnMock();
    const pcm = makeTestPcmSource();

    const writer = new MeetStorageWriter("m1", {
      getWorkspaceDir: () => workspaceDir,
      subscribe: dispatcher.subscribe,
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
    });
    writer.start();
    await writer.startAudio(pcm.source);

    // Exactly one spawn; argv ends in the resolved audio.opus path.
    expect(calls()).toHaveLength(1);
    const call = calls()[0];
    expect(call.cmd).toBe("ffmpeg");
    const argv = call.args;
    expect(argv[argv.length - 1]).toBe(
      join(workspaceDir, "meets", "m1", "audio.opus"),
    );
    expect(argv).toContain("-f");
    expect(argv).toContain("s16le");
    expect(argv).toContain("pipe:0");
    expect(argv).toContain("libopus");

    // Push PCM — the mock child records bytes.
    pcm.push(new Uint8Array([1, 2, 3, 4]));
    pcm.push(new Uint8Array([5, 6]));

    const child = lastChild();
    expect(child).not.toBeNull();
    const received = Buffer.concat(child!.stdin.chunks);
    expect(received.equals(Buffer.from([1, 2, 3, 4, 5, 6]))).toBe(true);

    // stop() closes ffmpeg stdin and drops the pcm subscription.
    await writer.stop();
    expect(child!.stdin.ended).toBe(true);
    expect(pcm.subscribers).toBe(0);
  });

  test("lifecycle:left closes ffmpeg stdin even without stop()", async () => {
    const dispatcher = makeFakeDispatcher();
    const { spawn, lastChild } = makeSpawnMock();
    const pcm = makeTestPcmSource();

    const writer = new MeetStorageWriter("m1", {
      getWorkspaceDir: () => workspaceDir,
      subscribe: dispatcher.subscribe,
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
    });
    writer.start();
    await writer.startAudio(pcm.source);

    dispatcher.dispatch(
      "m1",
      lifecycleLeft("m1", "2024-01-01T00:00:00.000Z"),
    );

    expect(lastChild()!.stdin.ended).toBe(true);

    await writer.stop();
  });

  test("startAudio is a no-op after the first spawn", async () => {
    const dispatcher = makeFakeDispatcher();
    const { spawn } = makeSpawnMock();
    const pcm = makeTestPcmSource();

    const writer = new MeetStorageWriter("m1", {
      getWorkspaceDir: () => workspaceDir,
      subscribe: dispatcher.subscribe,
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
    });
    writer.start();
    await writer.startAudio(pcm.source);
    await writer.startAudio(pcm.source);

    expect(spawn).toHaveBeenCalledTimes(1);

    await writer.stop();
  });
});

describe("MeetStorageWriter fsync cadence", () => {
  test("fsyncs after FSYNC_WRITE_THRESHOLD writes", async () => {
    // Frozen clock so only the write-count threshold can trigger fsync.
    const dispatcher = makeFakeDispatcher();
    const now = () => 0;
    const fsyncSyncMock = mock((_fd: number) => {});
    const writer = new MeetStorageWriter("m1", {
      getWorkspaceDir: () => workspaceDir,
      subscribe: dispatcher.subscribe,
      now,
      fs: {
        fsyncSync:
          fsyncSyncMock as unknown as typeof import("node:fs").fsyncSync,
      },
    });
    writer.start();

    for (let i = 0; i < FSYNC_WRITE_THRESHOLD; i++) {
      dispatcher.dispatch(
        "m1",
        transcriptChunk(
          "m1",
          `2024-01-01T00:00:${i.toString().padStart(2, "0")}.000Z`,
          "x",
          {
            isFinal: true,
          },
        ),
      );
    }
    // At threshold, at least one fsync should have been triggered by the
    // write-count path (on the transcript fd).
    const countsBeforeStop = fsyncSyncMock.mock.calls.length;
    expect(countsBeforeStop).toBeGreaterThanOrEqual(1);

    await writer.stop();
  });

  test("fsyncs when FSYNC_INTERVAL_MS elapses between writes", async () => {
    const dispatcher = makeFakeDispatcher();
    let t = 0;
    const now = () => t;
    const fsyncSyncMock = mock((_fd: number) => {});
    const writer = new MeetStorageWriter("m1", {
      getWorkspaceDir: () => workspaceDir,
      subscribe: dispatcher.subscribe,
      now,
      fs: {
        fsyncSync:
          fsyncSyncMock as unknown as typeof import("node:fs").fsyncSync,
      },
    });
    writer.start();

    // First write establishes the fd; lastFlushAtMs is set to 0.
    dispatcher.dispatch(
      "m1",
      transcriptChunk("m1", "2024-01-01T00:00:00.000Z", "x", {
        isFinal: true,
      }),
    );
    const beforeJump = fsyncSyncMock.mock.calls.length;

    // Jump the clock past the interval and write again — must trigger fsync.
    t = FSYNC_INTERVAL_MS + 1;
    dispatcher.dispatch(
      "m1",
      transcriptChunk("m1", "2024-01-01T00:00:10.000Z", "y", {
        isFinal: true,
      }),
    );
    expect(fsyncSyncMock.mock.calls.length).toBeGreaterThan(beforeJump);

    await writer.stop();
  });
});

describe("MeetStorageWriter error resilience", () => {
  test("events to an unrelated meetingId never reach this writer", async () => {
    const dispatcher = makeFakeDispatcher();
    const writer = new MeetStorageWriter("m1", {
      getWorkspaceDir: () => workspaceDir,
      subscribe: dispatcher.subscribe,
    });
    writer.start();

    // Dispatch to a different meeting — the fake dispatcher simply drops it
    // because m2 has no subscribers.
    dispatcher.dispatch(
      "m2",
      transcriptChunk("m2", "2024-01-01T00:00:00.000Z", "nope", {
        isFinal: true,
      }),
    );

    await writer.stop();

    expect(
      existsSync(join(workspaceDir, "meets", "m1", "transcript.jsonl")),
    ).toBe(false);
  });

  test("stop() is idempotent", async () => {
    const dispatcher = makeFakeDispatcher();
    const writer = new MeetStorageWriter("m1", {
      getWorkspaceDir: () => workspaceDir,
      subscribe: dispatcher.subscribe,
    });
    writer.start();
    await writer.stop();
    await writer.stop();
    expect(dispatcher.subscriberCount("m1")).toBe(0);
  });
});
