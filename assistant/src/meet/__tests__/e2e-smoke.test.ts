/**
 * End-to-end smoke test for the Meet pipeline.
 *
 * This test stitches together every live piece of the Meet subsystem —
 * {@link MeetSessionManager}, {@link MeetAudioIngestLike} mock, the
 * {@link MeetConversationBridge}, {@link MeetStorageWriter},
 * {@link MeetConsentMonitor}, {@link MeetSpeakerResolver}, and the shared
 * {@link meetEventDispatcher} — and drives a scripted bot-event stream
 * through the whole graph.
 *
 * Nothing here touches a real Docker daemon, a real Meet URL, a real
 * Deepgram account, or a real LLM provider. The `DockerRunner`, audio
 * ingest, and consent LLM are all replaced with fakes. ffmpeg is mocked
 * too — the test captures PCM bytes that would otherwise be piped into an
 * Opus encoder. What we *do* exercise for real:
 *
 *   - Router → dispatcher fan-out via `registerMeetingDispatcher` and
 *     `subscribeEventHubPublisher`.
 *   - `assistantEventHub` delivery of `meet.*` messages (captured via
 *     {@link captureHub}).
 *   - The real storage writer against a tempdir workspace, constructed
 *     inside `MeetSessionManager.join()` — segments/transcript/participants
 *     files are written through the real fs primitives, and `audio.opus`
 *     is staged with a mocked ffmpeg child so we can assert PCM delivery
 *     without a real encoder binary.
 *   - The real conversation bridge (constructed by the manager with a
 *     recording `insertMessage` adapter) so we can assert message order,
 *     roles, content, and metadata.
 *   - The real consent monitor — scripted LLM verdict — driving a real
 *     `sessionManager.leave()` which in turn drives the real teardown
 *     path (dispatcher unsubscribes, audio ingest stop, router
 *     unregistration, synthesized `lifecycle:left` dispatch so meta.json
 *     lands, `meet.left` publication).
 *
 * The scripted event stream follows the plan's acceptance spec:
 *
 *   1. `lifecycle:joining` → `meet.joining` on hub.
 *   2. `lifecycle:joined`  → `meet.joined` on hub.
 *   3. `ParticipantChangeEvent` (Alice joined) → participants.json + "Alice joined".
 *   4. `TranscriptChunkEvent` (interim) → ephemeral hub event, no conversation insert.
 *   5. `TranscriptChunkEvent` (final, Alice) → conversation insert + transcript.jsonl append.
 *   6. `SpeakerChangeEvent` to Bob → segments.jsonl entry.
 *   7. `InboundChatEvent` "please leave" → consent monitor fires → LLM objects → leave.
 *   8. leave() synthesizes `lifecycle:left` → meta.json written + `meet.left` on hub.
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  InboundChatEvent,
  LifecycleEvent,
  ParticipantChangeEvent,
  SpeakerChangeEvent,
  TranscriptChunkEvent,
} from "@vellumai/meet-contracts";

import type { AssistantEvent } from "../../runtime/assistant-event.js";
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../runtime/assistant-scope.js";
import { MeetConsentMonitor } from "../consent-monitor.js";
import {
  type InsertMessageFn,
  MeetConversationBridge,
} from "../conversation-bridge.js";
import {
  meetEventDispatcher,
  subscribeToMeetingEvents,
} from "../event-publisher.js";
import {
  __resetMeetSessionEventRouterForTests,
  getMeetSessionEventRouter,
} from "../session-event-router.js";
import {
  _createMeetSessionManagerForTests,
  MEET_BOT_INTERNAL_PORT,
  MEET_SHUTDOWN_DEADLINE_MS,
  type MeetAudioIngestLike,
} from "../session-manager.js";
import { MeetStorageWriter } from "../storage-writer.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MEETING_ID = "meet-e2e-1";
const CONVERSATION_ID = "conv-e2e-1";

interface InsertCall {
  conversationId: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
  opts?: { skipIndexing?: boolean };
}

function makeInsertRecorder(): { fn: InsertMessageFn; calls: InsertCall[] } {
  const calls: InsertCall[] = [];
  let counter = 0;
  const fn: InsertMessageFn = async (
    conversationId,
    role,
    content,
    metadata,
    opts,
  ) => {
    calls.push({ conversationId, role, content, metadata, opts });
    counter += 1;
    return { id: `msg-${counter}` };
  };
  return { fn, calls };
}

interface FakeAudioIngest extends MeetAudioIngestLike {
  start: ReturnType<typeof mock>;
  stop: ReturnType<typeof mock>;
  subscribePcm: ReturnType<typeof mock>;
  /** Test helper: push a PCM chunk to every subscriber. */
  pushPcm: (bytes: Uint8Array) => void;
}

function makeFakeAudioIngestFactory(): {
  factory: () => FakeAudioIngest;
  getLastIngest: () => FakeAudioIngest | null;
} {
  let last: FakeAudioIngest | null = null;
  return {
    factory: () => {
      const subscribers = new Set<(bytes: Uint8Array) => void>();
      const ingest: FakeAudioIngest = {
        start: mock(async () => {}),
        stop: mock(async () => {}),
        subscribePcm: mock((cb: (bytes: Uint8Array) => void) => {
          subscribers.add(cb);
          return () => subscribers.delete(cb);
        }),
        pushPcm: (bytes) => {
          for (const cb of subscribers) cb(bytes);
        },
      };
      last = ingest;
      return ingest;
    },
    getLastIngest: () => last,
  };
}

function makeMockRunner() {
  return {
    run: mock(async () => ({
      containerId: "container-e2e-1",
      boundPorts: [
        {
          protocol: "tcp" as const,
          containerPort: MEET_BOT_INTERNAL_PORT,
          hostIp: "127.0.0.1",
          hostPort: 49210,
        },
      ],
    })),
    stop: mock(async () => {}),
    remove: mock(async () => {}),
    inspect: mock(async () => ({ Id: "container-e2e-1" })),
  };
}

/**
 * Mock ffmpeg child process. The real storage writer spawns ffmpeg and
 * pipes s16le PCM into its stdin; in the test we capture those bytes via
 * this EventEmitter-backed stub so we can assert PCM flowed through the
 * subscribePcm tee + PcmSource bridge.
 */
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
} {
  let child: MockFfmpegChild | null = null;
  const spawn = mock(() => {
    child = makeMockFfmpegChild();
    return child as unknown as ReturnType<
      typeof import("node:child_process").spawn
    >;
  });
  return {
    spawn,
    lastChild: () => child,
  };
}

function captureHub(assistantId: string): {
  received: AssistantEvent[];
  dispose: () => void;
} {
  const received: AssistantEvent[] = [];
  const sub = assistantEventHub.subscribe({ assistantId }, (event) => {
    received.push(event);
  });
  return { received, dispose: () => sub.dispose() };
}

/**
 * Block on a microtask flush so dispatched events have a chance to run
 * through every subscriber before assertions.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

// ── Event builders ─────────────────────────────────────────────────────────

function lifecycleEvent(
  state: LifecycleEvent["state"],
  timestamp: string,
): LifecycleEvent {
  return {
    type: "lifecycle",
    meetingId: MEETING_ID,
    timestamp,
    state,
  };
}

function participantJoined(
  timestamp: string,
  id: string,
  name: string,
): ParticipantChangeEvent {
  return {
    type: "participant.change",
    meetingId: MEETING_ID,
    timestamp,
    joined: [{ id, name }],
    left: [],
  };
}

function transcriptChunk(
  timestamp: string,
  text: string,
  options: {
    isFinal?: boolean;
    speakerLabel?: string;
    speakerId?: string;
  } = {},
): TranscriptChunkEvent {
  return {
    type: "transcript.chunk",
    meetingId: MEETING_ID,
    timestamp,
    isFinal: options.isFinal ?? true,
    text,
    speakerLabel: options.speakerLabel,
    speakerId: options.speakerId,
  };
}

function speakerChange(
  timestamp: string,
  speakerId: string,
  speakerName: string,
): SpeakerChangeEvent {
  return {
    type: "speaker.change",
    meetingId: MEETING_ID,
    timestamp,
    speakerId,
    speakerName,
  };
}

function inboundChat(
  timestamp: string,
  text: string,
  fromName: string,
  fromId: string,
): InboundChatEvent {
  return {
    type: "chat.inbound",
    meetingId: MEETING_ID,
    timestamp,
    fromId,
    fromName,
    text,
  };
}

function readJsonlLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Shared per-test state
// ---------------------------------------------------------------------------

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "meet-e2e-"));
  __resetMeetSessionEventRouterForTests();
  meetEventDispatcher._resetForTests();
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
  __resetMeetSessionEventRouterForTests();
  meetEventDispatcher._resetForTests();
});

// ---------------------------------------------------------------------------
// E2E smoke test
// ---------------------------------------------------------------------------

describe("Meet pipeline end-to-end", () => {
  test("scripted bot event stream drives conversation, storage, hub, and consent-triggered leave", async () => {
    // ── Wire the fan-out singletons first so the session manager's
    //    `subscribeEventHubPublisher` + the downstream consumers all
    //    converge on one dispatcher keyed by meetingId.
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const { spawn, lastChild } = makeSpawnMock();

    const consentLlm = mock(async () => ({
      objected: true,
      reason: "participant asked the bot to leave",
    }));

    // Recording insert shim captures every addMessage call the production
    // `MeetConversationBridge` makes, so we can assert message ordering,
    // roles, and metadata without touching the real database.
    const insert = makeInsertRecorder();

    // Build the session manager with the minimum surface area swapped out.
    //   - `consentMonitorFactory` yields a real {@link MeetConsentMonitor}
    //     with a scripted LLM verdict so the keyword fast-path → slow-path
    //     flow runs end-to-end.
    //   - `conversationBridgeFactory` yields a real
    //     {@link MeetConversationBridge} wired to the recording insert shim
    //     so we exercise the actual dispatch path.
    //   - `storageWriterFactory` yields a real {@link MeetStorageWriter}
    //     pointed at the tempdir workspace with a mocked ffmpeg spawn.
    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async (provider) => {
        if (provider === "tts") return "tts-secret";
        return "";
      },
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {}, // graceful bot /leave
      audioIngestFactory: audioIngestFactory.factory,
      resolveDaemonUrl: () => "http://host.docker.internal:7821",
      consentMonitorFactory: ({ meetingId, assistantId, sessionManager }) =>
        new MeetConsentMonitor({
          meetingId,
          assistantId,
          sessionManager,
          config: {
            autoLeaveOnObjection: true,
            objectionKeywords: ["please leave"],
          },
          llmAsk: consentLlm,
          subscribe: subscribeToMeetingEvents,
        }),
      conversationBridgeFactory: ({ meetingId, conversationId }) =>
        new MeetConversationBridge({
          meetingId,
          conversationId,
          insertMessage: insert.fn,
        }),
      storageWriterFactory: ({ meetingId }) =>
        new MeetStorageWriter(meetingId, {
          getWorkspaceDir: () => workspaceDir,
          spawn: spawn as unknown as typeof import("node:child_process").spawn,
        }),
    });

    // Capture every `meet.*` event emitted by the pipeline on the daemon
    // assistant id — that's what the session manager publishes to.
    const hub = captureHub(DAEMON_INTERNAL_ASSISTANT_ID);

    try {
      // ── 1/2: `join()` publishes `meet.joining`. Then, once we dispatch
      //    `lifecycle:joined`, the session manager's lifecycle subscriber
      //    publishes `meet.joined`. `join()` also constructs + subscribes
      //    the bridge and the writer — no pre-registration needed.
      await manager.join({
        url: "https://meet.google.com/xyz-abc-def",
        meetingId: MEETING_ID,
        conversationId: CONVERSATION_ID,
      });

      // At this point `meet.joining` should already be in the hub buffer.
      await flush();
      expect(
        hub.received
          .map((e) => e.message.type)
          .filter((t) => t === "meet.joining"),
      ).toHaveLength(1);

      const router = getMeetSessionEventRouter();

      // ── 2: lifecycle:joined → meet.joined
      router.dispatch(
        MEETING_ID,
        lifecycleEvent("joined", "2025-01-01T00:00:00.100Z"),
      );
      await flush();
      expect(
        hub.received
          .map((e) => e.message.type)
          .filter((t) => t === "meet.joined"),
      ).toHaveLength(1);

      // ── 3: participant.change (Alice joined)
      router.dispatch(
        MEETING_ID,
        participantJoined("2025-01-01T00:00:00.500Z", "p-alice", "Alice"),
      );
      await flush();

      // participants.json materialized by the real storage writer.
      const participantsPath = join(
        workspaceDir,
        "meets",
        MEETING_ID,
        "participants.json",
      );
      expect(existsSync(participantsPath)).toBe(true);
      expect(JSON.parse(readFileSync(participantsPath, "utf8"))).toEqual([
        { id: "p-alice", name: "Alice" },
      ]);

      // Conversation has the "Alice joined" system line from the bridge.
      const joinLine = insert.calls.find((c) => {
        try {
          const parts = JSON.parse(c.content) as Array<{ text: string }>;
          return parts.some((p) => p.text === "Alice joined");
        } catch {
          return false;
        }
      });
      expect(joinLine).toBeDefined();
      expect(joinLine?.role).toBe("assistant");
      expect(joinLine?.opts).toMatchObject({ skipIndexing: true });
      expect(joinLine?.metadata).toMatchObject({
        meetingId: MEETING_ID,
        meetParticipantId: "p-alice",
        meetParticipantChange: "joined",
        automated: true,
      });

      // Hub also saw meet.participant_changed.
      expect(
        hub.received.find((e) => e.message.type === "meet.participant_changed"),
      ).toBeDefined();

      // ── 3b: speaker.change to Alice so the resolver binds the label + the
      //    storage writer opens a segment. (The plan calls out a bind for the
      //    final transcript chunk in step 5.)
      router.dispatch(
        MEETING_ID,
        speakerChange("2025-01-01T00:00:00.900Z", "p-alice", "Alice"),
      );
      await flush();
      // meet.speaker_changed fanned to hub.
      expect(
        hub.received.find((e) => e.message.type === "meet.speaker_changed"),
      ).toBeDefined();

      // ── 4: interim transcript — should not land in conversation nor in
      //    transcript.jsonl. The bridge does publish a hub-scoped interim
      //    event (`meet.transcript_interim`) in addition.
      const conversationCallsBefore = insert.calls.length;
      router.dispatch(
        MEETING_ID,
        transcriptChunk("2025-01-01T00:00:01.000Z", "Hello th", {
          isFinal: false,
          speakerLabel: "speaker-0",
          speakerId: "speaker-0",
        }),
      );
      await flush();
      expect(insert.calls.length).toBe(conversationCallsBefore);

      // Hub received the interim event for the live UI. `meet.transcript_interim`
      // is a bridge-internal hub event (not in the `ServerMessage` union type
      // because it's cast through `as unknown as ServerMessage`), so compare
      // via string to avoid a tsc narrowing error.
      const interimEvent = hub.received.find(
        (e) => (e.message.type as string) === "meet.transcript_interim",
      );
      expect(interimEvent).toBeDefined();

      // ── 5: final transcript from Alice (speaker label already bound via
      //    the DOM snapshot above). Expect:
      //       - conversation insert with `[Alice]: Hello there!`
      //       - transcript.jsonl append
      //       - meet.transcript_chunk on hub (final only)
      router.dispatch(
        MEETING_ID,
        transcriptChunk("2025-01-01T00:00:01.050Z", "Hello there!", {
          isFinal: true,
          speakerLabel: "speaker-0",
          speakerId: "speaker-0",
        }),
      );
      await flush();

      const aliceFinal = insert.calls.find((c) => {
        try {
          const parts = JSON.parse(c.content) as Array<{ text: string }>;
          return parts.some((p) => p.text === "[Alice]: Hello there!");
        } catch {
          return false;
        }
      });
      expect(aliceFinal).toBeDefined();
      expect(aliceFinal?.role).toBe("user");
      expect(aliceFinal?.metadata).toMatchObject({
        meetingId: MEETING_ID,
        meetSpeakerName: "Alice",
      });

      expect(
        hub.received.find((e) => e.message.type === "meet.transcript_chunk"),
      ).toBeDefined();

      // ── 6: speaker.change to Bob — closes Alice's span in segments.jsonl.
      router.dispatch(
        MEETING_ID,
        speakerChange("2025-01-01T00:00:02.000Z", "p-bob", "Bob"),
      );
      await flush();

      // At least one segment row has landed (Alice → Bob boundary).
      const segmentsPath = join(
        workspaceDir,
        "meets",
        MEETING_ID,
        "segments.jsonl",
      );
      const segmentsAfterBob = readJsonlLines(segmentsPath);
      expect(segmentsAfterBob.length).toBeGreaterThanOrEqual(1);
      expect(segmentsAfterBob[0]).toMatchObject({
        start: "2025-01-01T00:00:00.900Z",
        end: "2025-01-01T00:00:02.000Z",
        speakerId: "p-alice",
        speakerName: "Alice",
      });

      // ── 6b: push some PCM bytes through the audio-ingest tee so the
      //    storage writer's PcmSource → ffmpeg stdin bridge actually moves
      //    bytes. Nothing in the bot-event stream drives this — production
      //    code gets bytes straight off the Unix socket, the test fake
      //    exposes `pushPcm(...)` instead.
      const ingest = audioIngestFactory.getLastIngest()!;
      ingest.pushPcm(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
      ingest.pushPcm(new Uint8Array([0x05, 0x06]));

      // ── 7: inbound chat with objection phrase → consent monitor fires the
      //    scripted LLM which returns `objected: true`, which invokes
      //    `manager.leave("objection: ...")`. The leave path:
      //       - synthesizes lifecycle:left so the writer flushes meta.json,
      //       - stops the bridge + writer,
      //       - unregisters the router handler (dispatch becomes a no-op),
      //       - stops the consent monitor + audio ingest,
      //       - hits the mock bot `/leave`,
      //       - publishes `meet.left` on the hub.
      const leaveStart = Date.now();
      router.dispatch(
        MEETING_ID,
        inboundChat(
          "2025-01-01T00:00:03.000Z",
          "Bot, please leave the meeting.",
          "Carol",
          "p-carol",
        ),
      );

      // Wait for the consent LLM + leave path to settle, bounded so the
      // test can't hang on a dead consent monitor. The plan calls for a
      // simulated-2s cap on this path.
      const leaveDeadline = 2000;
      while (
        manager.getSession(MEETING_ID) !== null &&
        Date.now() - leaveStart < leaveDeadline
      ) {
        await flush();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(manager.getSession(MEETING_ID)).toBeNull();
      expect(consentLlm).toHaveBeenCalledTimes(1);
      expect(Date.now() - leaveStart).toBeLessThan(leaveDeadline);

      // ── 8: `meet.left` on hub; the manager synthesized `lifecycle:left`
      //    during leave() BEFORE tearing down the dispatcher so the
      //    writer's meta.json flush ran while its subscription was still
      //    live.
      expect(
        hub.received.find((e) => e.message.type === "meet.left"),
      ).toBeDefined();

      // Event order sanity check — every `meet.*` type we expect was
      // observed and `meet.left` came last among the lifecycle transitions.
      const lifecycleKinds = hub.received
        .map((e) => e.message.type)
        .filter(
          (t) =>
            t === "meet.joining" || t === "meet.joined" || t === "meet.left",
        );
      expect(lifecycleKinds).toEqual([
        "meet.joining",
        "meet.joined",
        "meet.left",
      ]);

      // Audio ingest was stopped during leave.
      expect(ingest.stop).toHaveBeenCalledTimes(1);
      // Bot /leave endpoint was hit, container was removed.
      expect(runner.remove).toHaveBeenCalledTimes(1);

      // ffmpeg received the PCM bytes we pushed through the tee.
      const ffmpegChild = lastChild();
      expect(ffmpegChild).not.toBeNull();
      const forwardedPcm = Buffer.concat(ffmpegChild!.stdin.chunks);
      expect(Array.from(forwardedPcm)).toEqual([
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
      ]);
      // ffmpeg stdin was closed on leave (either via synthesized
      // lifecycle:left or writer.stop()).
      expect(ffmpegChild!.stdin.ended).toBe(true);
    } finally {
      hub.dispose();
    }

    // ── Final artifact inspection — every on-disk file the plan calls out
    //    exists and carries the expected shape. `audio.opus` is staged by
    //    ffmpeg; with the mock spawn, the file does not exist on disk, but
    //    the ffmpeg argv was asserted above via the chunks + stdin end.
    const meetingDir = join(workspaceDir, "meets", MEETING_ID);
    expect(existsSync(join(meetingDir, "participants.json"))).toBe(true);
    expect(existsSync(join(meetingDir, "transcript.jsonl"))).toBe(true);
    expect(existsSync(join(meetingDir, "segments.jsonl"))).toBe(true);
    // meta.json is written when `lifecycle:left` reaches the writer. The
    // session manager synthesizes this event on leave() BEFORE tearing
    // the dispatcher down, so meta.json must be present.
    expect(existsSync(join(meetingDir, "meta.json"))).toBe(true);

    const meta = JSON.parse(
      readFileSync(join(meetingDir, "meta.json"), "utf8"),
    );
    expect(meta.meetingId).toBe(MEETING_ID);
    expect(typeof meta.startedAt).toBe("string");
    expect(typeof meta.endedAt).toBe("string");

    const transcriptLines = readJsonlLines(
      join(meetingDir, "transcript.jsonl"),
    );
    expect(transcriptLines.length).toBeGreaterThanOrEqual(1);
    expect(transcriptLines[0]).toMatchObject({
      timestamp: "2025-01-01T00:00:01.050Z",
      text: "Hello there!",
      speakerId: "speaker-0",
      speakerLabel: "speaker-0",
    });
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown — daemon SIGTERM while a Meet is live
// ---------------------------------------------------------------------------

describe("MeetSessionManager.shutdownAll", () => {
  test("leaves every active session and publishes meet.left on the hub", async () => {
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
      consentMonitorFactory: () => ({ start: () => {}, stop: () => {} }),
    });

    await manager.join({
      url: "u",
      meetingId: "mshut-1",
      conversationId: "c1",
    });
    // Second session with a distinct id — shutdownAll should leave both.
    runner.run = mock(async () => ({
      containerId: "container-e2e-2",
      boundPorts: [
        {
          protocol: "tcp" as const,
          containerPort: MEET_BOT_INTERNAL_PORT,
          hostIp: "127.0.0.1",
          hostPort: 49211,
        },
      ],
    }));
    await manager.join({
      url: "u2",
      meetingId: "mshut-2",
      conversationId: "c2",
    });
    expect(manager.activeSessions()).toHaveLength(2);

    const hub = captureHub(DAEMON_INTERNAL_ASSISTANT_ID);
    try {
      await manager.shutdownAll("daemon-shutdown");
      expect(manager.activeSessions()).toHaveLength(0);

      // Both sessions produced a `meet.left` with the shutdown reason.
      const lefts = hub.received.filter(
        (e) => e.message.type === "meet.left",
      ) as Array<AssistantEvent & { message: { reason: string } }>;
      expect(lefts).toHaveLength(2);
      for (const left of lefts) {
        expect(left.message.reason).toBe("daemon-shutdown");
      }
    } finally {
      hub.dispose();
    }
  });

  test("force-stops remaining containers when the shared deadline expires", async () => {
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();

    // botLeaveFetch hangs past the shutdown deadline — forcing the
    // force-stop fallback for any session that hasn't rolled over to
    // `runner.stop` on its own yet.
    const hangingBotLeave = mock(
      () => new Promise<void>(() => {}), // never resolves
    );

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: hangingBotLeave,
      audioIngestFactory: audioIngestFactory.factory,
      consentMonitorFactory: () => ({ start: () => {}, stop: () => {} }),
    });

    await manager.join({
      url: "u",
      meetingId: "mshut-force",
      conversationId: "c",
    });
    expect(manager.activeSessions()).toHaveLength(1);

    // 50ms deadline — small enough to fit comfortably in test wall clock,
    // large enough that hangingBotLeave can't race it to completion.
    await manager.shutdownAll("daemon-shutdown", 50);
    // Session record dropped.
    expect(manager.activeSessions()).toHaveLength(0);
    // Force stop + remove were invoked on the straggler.
    expect(runner.stop).toHaveBeenCalled();
    expect(runner.remove).toHaveBeenCalled();
    // Audio ingest was stopped too.
    const ingest = audioIngestFactory.getLastIngest();
    expect(ingest?.stop).toHaveBeenCalled();
  });

  test("no-op when nothing is active", async () => {
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
    });

    await manager.shutdownAll("daemon-shutdown");
    expect(runner.stop).toHaveBeenCalledTimes(0);
    expect(runner.remove).toHaveBeenCalledTimes(0);
  });

  test("MEET_SHUTDOWN_DEADLINE_MS is the 15s budget the plan calls out", () => {
    expect(MEET_SHUTDOWN_DEADLINE_MS).toBe(15_000);
  });
});
