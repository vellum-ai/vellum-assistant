import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../__tests__/helpers/set-config.js";
import type {
  VoiceTurnCallbacks,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";
import type { LiveVoiceFluxConfig } from "../../config/schemas/live-voice.js";
import type {
  StreamingTranscriber,
  SttProviderId,
  SttStreamServerEvent,
} from "../../stt/types.js";
import {
  LiveVoiceSession,
  type LiveVoiceTtsStreamer,
} from "../live-voice-session.js";
import type { LiveVoiceSessionFactoryContext } from "../live-voice-session-manager.js";
import type {
  LiveVoiceTtsOptions,
  LiveVoiceTtsResult,
} from "../live-voice-tts.js";
import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceClientStartFrame,
  type LiveVoiceServerFrame,
} from "../protocol.js";

const SAMPLE_RATE = 24_000;

const VAD_START_FRAME = {
  type: "start",
  conversationId: "conversation-123",
  turnDetection: "server_vad",
  audio: {
    mimeType: "audio/pcm",
    sampleRate: SAMPLE_RATE,
    channels: 1,
  },
} as const satisfies LiveVoiceClientStartFrame;

function pcm(amplitude: number, sampleCount = 240): Uint8Array {
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    buffer.writeInt16LE(amplitude, index * 2);
  }
  return new Uint8Array(buffer);
}

// 10 ms of speech at 24 kHz.
const LOUD_CHUNK = pcm(8_000);
// 300 ms of speech at 24 kHz, comfortably past the default sustained-speech
// barge-in guard (250 ms) in a single chunk.
const SUSTAINED_LOUD_CHUNK = pcm(8_000, 7_200);

/**
 * Flux-shaped streaming transcriber: no `finalizeUtterance` (Flux owns turn
 * boundaries, so the session runs it per cycle), and every transcript event is
 * scripted by the test. `stop()` closes without inventing a trailing final,
 * exactly as Flux does: its transcript is committed by EndOfTurn.
 */
class MockFluxTranscriber implements StreamingTranscriber {
  readonly boundaryId = "daemon-streaming" as const;
  readonly received: Buffer[] = [];
  stopped = false;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  constructor(readonly providerId: SttProviderId) {}

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(chunk: Buffer): void {
    this.received.push(Buffer.from(chunk));
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.onEvent?.({ type: "closed" });
  }

  emit(event: SttStreamServerEvent): void {
    this.onEvent?.(event);
  }

  // Flux's StartOfTurn frame, numbering the turn it opens.
  startOfTurn(turnIndex: number): void {
    this.emit({ type: "turn-start", turnIndex });
  }

  // Flux's EndOfTurn frame maps onto a `final` followed by a `turn-end`.
  endOfTurn(text: string, turnIndex?: number): void {
    this.emit({ type: "final", text });
    this.emit({
      type: "turn-end",
      text,
      confidence: 0.9,
      ...(turnIndex !== undefined ? { turnIndex } : {}),
    });
  }
}

function createHarness(options: {
  providerId?: SttProviderId;
  fluxConfig?: Partial<LiveVoiceFluxConfig>;
  silenceThresholdMs?: number;
  startVoiceTurn?: (options: VoiceTurnOptions) => Promise<{
    turnId: string;
    abort: () => void;
  }>;
  streamTtsAudio?: LiveVoiceTtsStreamer | null;
  emitMetrics?: boolean;
  // Holds the STT dial open so a test can drive a whole utterance through the
  // window between `ready` and the resolved provider.
  resolveGate?: Promise<unknown>;
}) {
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];
  const context: LiveVoiceSessionFactoryContext = {
    sessionId: "session-123",
    startFrame: VAD_START_FRAME,
    sendFrame: mock(async (payload) => {
      const frame = sequencer.next(payload);
      frames.push(frame);
      return frame;
    }),
  };

  const transcribers: MockFluxTranscriber[] = [];
  const resolveTranscriber = mock(async () => {
    if (options.resolveGate) {
      await options.resolveGate;
    }
    const transcriber = new MockFluxTranscriber(
      options.providerId ?? "deepgram-flux",
    );
    transcribers.push(transcriber);
    return transcriber;
  });

  const turnCalls: VoiceTurnOptions[] = [];
  const startVoiceTurn = mock(async (turnOptions: VoiceTurnOptions) => {
    turnCalls.push(turnOptions);
    if (options.startVoiceTurn) {
      return await options.startVoiceTurn(turnOptions);
    }
    return { turnId: `bridge-turn-${turnCalls.length}`, abort: mock() };
  });

  const session = new LiveVoiceSession(context, {
    resolveTranscriber,
    startVoiceTurn,
    streamTtsAudio: options.streamTtsAudio ?? null,
    emitMetrics: options.emitMetrics ?? false,
    spawnBackgroundContinuation: mock(async () => ""),
    turnDetectorConfig: {
      silenceThresholdMs: options.silenceThresholdMs ?? 40,
    },
    ...(options.fluxConfig ? { fluxConfig: options.fluxConfig } : {}),
  });

  return { frames, session, transcribers, turnCalls };
}

function makeTextDelta(
  text: string,
): Parameters<NonNullable<VoiceTurnCallbacks["assistant_text_delta"]>>[0] {
  return {
    type: "assistant_text_delta",
    text,
    conversationId: "conversation-123",
  };
}

function makeMessageComplete(): Parameters<
  NonNullable<VoiceTurnCallbacks["message_complete"]>
>[0] {
  return {
    type: "message_complete",
    conversationId: "conversation-123",
    messageId: "assistant-message-123",
  };
}

// Answers immediately: one text delta (which commits a speculative leg), then
// message_complete.
function autoCompletingTurn(
  reply = "Okay.",
): (
  options: VoiceTurnOptions,
) => Promise<{ turnId: string; abort: () => void }> {
  let count = 0;
  return async (options) => {
    count += 1;
    options.callbacks?.assistant_text_delta?.(makeTextDelta(reply));
    options.callbacks?.message_complete?.(makeMessageComplete());
    return { turnId: `bridge-turn-${count}`, abort: mock() };
  };
}

async function waitFor(
  predicate: () => boolean,
  message = "Timed out waiting for a live voice Flux test condition",
): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function flushAsyncCallbacks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Holds the STT dial open until the test opens it, so the whole
// ready-before-resolve window is under the test's control.
function createDialGate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

function countFrames(
  frames: LiveVoiceServerFrame[],
  type: LiveVoiceServerFrame["type"],
): number {
  return frames.filter((frame) => frame.type === type).length;
}

// Waits for the completed turn's metrics frame and hands it back narrowed, so
// the assertions below read the endpoint fields without a type guard.
async function waitForTurnMetrics(
  frames: LiveVoiceServerFrame[],
): Promise<Extract<LiveVoiceServerFrame, { type: "metrics" }>> {
  const isTurnMetrics = (
    frame: LiveVoiceServerFrame,
  ): frame is Extract<LiveVoiceServerFrame, { type: "metrics" }> =>
    frame.type === "metrics" && frame.event === "turn_completed";
  await waitFor(
    () => frames.some(isTurnMetrics),
    "The completed turn never reported its metrics",
  );
  const metricsFrame = frames.find(isTurnMetrics);
  if (!metricsFrame) {
    throw new Error("The completed turn never reported its metrics");
  }
  return metricsFrame;
}

// Long enough for the 40 ms local silence timer to fire and hand the boundary
// to Flux (which arms the fail-open deadline and commits nothing).
const PAST_SILENCE_BOUNDARY_MS = 150;

const FLUX_ON = {
  turnEnd: { enabled: true },
  eotTimeoutMs: 500,
} as const satisfies Partial<LiveVoiceFluxConfig>;

describe("LiveVoiceSession Flux end-of-turn", () => {
  test("commits the turn on turn-end without an endpoint-decision leg", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      // Long enough that the local silence boundary cannot be what commits.
      silenceThresholdMs: 10_000,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.endOfTurn("what is the weather");

    await waitFor(() => turnCalls.length === 1);
    expect(turnCalls[0]?.content).toBe("what is the weather");
    // Non-speculative dispatch: the front-door leg's decision rule is built
    // with includeHold false, so the hold token is never taught.
    expect(turnCalls[0]?.unifiedVerdict).toBeUndefined();
    expect(turnCalls[0]?.routingLeg).toBe("front-door");
    expect(frames.some((frame) => frame.type === "utterance_end")).toBe(true);

    await session.close("client_end");
  });

  test("still escalates on the [1] verdict after a flux commit", async () => {
    const { session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      silenceThresholdMs: 10_000,
      startVoiceTurn: async (turnOptions) => {
        if (turnOptions.routingLeg === "front-door") {
          turnOptions.callbacks?.assistant_text_delta?.(
            makeTextDelta("[1] Let me check that for you."),
          );
        }
        return { turnId: "bridge-turn", abort: mock() };
      },
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.endOfTurn("what is on my calendar");

    await waitFor(
      () => turnCalls.some((call) => call.routingLeg === "escalated"),
      "The escalate verdict never handed off to the escalated leg",
    );

    await session.close("client_end");
  });

  test("ignores turn-end when the flag is off and keeps the hold path", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.emit({ type: "partial", text: "hello there" });
    transcribers[0]?.endOfTurn("hello there");
    await flushAsyncCallbacks();

    // The turn-end event committed nothing: the silence boundary still owns
    // the commit, and it dispatches speculatively (the hold path).
    await waitFor(() => turnCalls.length === 1);
    expect(turnCalls[0]?.unifiedVerdict).toBe(true);
    expect(frames.some((frame) => frame.type === "utterance_end")).toBe(true);

    await session.close("client_end");
  });

  test("ignores turn-end from a provider that is not deepgram-flux", async () => {
    const { session, transcribers, turnCalls } = createHarness({
      providerId: "deepgram",
      fluxConfig: FLUX_ON,
      silenceThresholdMs: 10_000,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.endOfTurn("hello there");
    await flushAsyncCallbacks();

    expect(turnCalls).toHaveLength(0);

    await session.close("client_end");
  });

  test("reports the endpoint decision as flux", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      silenceThresholdMs: 10_000,
      emitMetrics: true,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.endOfTurn("hello there");
    await waitFor(() => turnCalls.length === 1);

    const metricsFrame = await waitForTurnMetrics(frames);
    expect(metricsFrame.endpointDecisionSource).toBe("provider");
    expect(metricsFrame.endpointHoldCount).toBe(0);

    await session.close("client_end");
  });

  test("anchors the flux commit latency at the local speech-stop mark", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: { turnEnd: { enabled: true }, eotTimeoutMs: 30_000 },
      // Long enough that the local silence boundary cannot be what commits,
      // and that the fail-open deadline stays far away.
      silenceThresholdMs: 10_000,
      emitMetrics: true,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    // Silence between the caller's last above-gate chunk and the commit. A
    // dispatch-anchored number would not see it; the speech-stop anchor must.
    await sleep(250);
    transcribers[0]?.endOfTurn("hello there");
    await waitFor(() => turnCalls.length === 1);

    const metricsFrame = await waitForTurnMetrics(frames);
    expect(metricsFrame.endpointCommitLatencyMs).toBeGreaterThanOrEqual(250);

    await session.close("client_end");
  });

  test("records the commit latency on the front-door path too, with no hold", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      // No flux config: the latch is down and the local silence boundary owns
      // the commit, which is arm A of the measurement run.
      silenceThresholdMs: 40,
      emitMetrics: true,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.emit({ type: "partial", text: "hello there" });
    await waitFor(() => turnCalls.length === 1);

    // The turn committed straight through, so it records no endpoint decision
    // at all. The commit latency is recorded regardless, which is what makes
    // the two arms one population rather than two.
    const metricsFrame = await waitForTurnMetrics(frames);
    expect(metricsFrame.endpointDecisionSource).toBeUndefined();
    expect(metricsFrame.endpointCommitLatencyMs).toBeGreaterThanOrEqual(40);

    await session.close("client_end");
  });

  test("records no commit latency for a turn that never committed", async () => {
    const { frames, session, transcribers } = createHarness({
      fluxConfig: { turnEnd: { enabled: true }, eotTimeoutMs: 30_000 },
      silenceThresholdMs: 10_000,
      emitMetrics: true,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.emit({ type: "partial", text: "hello the" });
    // Nothing ends this turn: no flux turn-end, no silence boundary, and the
    // fail-open deadline is 30 s away.
    await flushAsyncCallbacks();
    await session.close("client_end");

    const metricsFrames = frames.filter((frame) => frame.type === "metrics");
    expect(metricsFrames.length).toBeGreaterThan(0);
    for (const frame of metricsFrames) {
      expect(frame).not.toHaveProperty("endpointCommitLatencyMs");
    }
  });

  test("falls back to the silence-boundary path when no turn-end arrives", async () => {
    const { session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    // Flux is transcribing but its EndOfTurn never arrives.
    transcribers[0]?.emit({ type: "partial", text: "are you still there" });

    // The local silence boundary (40 ms) passes without committing anything:
    // the fallback deadline (eotTimeoutMs plus the margin) owns this
    // utterance.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(turnCalls).toHaveLength(0);

    await waitFor(
      () => turnCalls.length === 1,
      "Flux fallback never replayed the silence boundary",
    );
    // Back on the existing path: a speculative dispatch that knows the hold
    // token, judging the partial the silence boundary saw.
    expect(turnCalls[0]?.content).toBe("are you still there");
    expect(turnCalls[0]?.unifiedVerdict).toBe(true);

    await session.close("client_end");
  }, 10_000);

  test("commits a turn-end that arrives after the local silence boundary", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      silenceThresholdMs: 40,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);

    // The boundary passes and commits nothing: Flux owns it.
    await sleep(PAST_SILENCE_BOUNDARY_MS);
    expect(turnCalls).toHaveLength(0);

    // No resumed speech, so this turn-end is the one the boundary was waiting
    // for and it commits exactly as before.
    transcribers[0]?.endOfTurn("what is the weather");
    await waitFor(
      () => turnCalls.length === 1,
      "A non-stale turn-end after the silence boundary never committed",
    );
    expect(turnCalls[0]?.content).toBe("what is the weather");
    expect(turnCalls[0]?.unifiedVerdict).toBeUndefined();
    expect(frames.some((frame) => frame.type === "utterance_end")).toBe(true);

    await session.close("client_end");
  });

  test("drops a turn-end that arrives after the caller resumed speaking", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      silenceThresholdMs: 40,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    const transcriber = transcribers[0];
    transcriber?.emit({ type: "partial", text: "what is the" });
    await sleep(PAST_SILENCE_BOUNDARY_MS);

    // The caller draws breath and keeps going before the provider's turn-end
    // for the speech that boundary closed reaches the session.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(
      () => countFrames(frames, "speech_started") === 2,
      "The resumed speech never re-opened a detector turn",
    );
    const receivedBeforeResume = transcriber?.received.length ?? 0;

    transcriber?.emit({
      type: "turn-end",
      text: "what is the",
      confidence: 0.9,
    });
    await flushAsyncCallbacks();

    // Dropped: no boundary frame, the transcriber keeps running, no turn.
    expect(frames.some((frame) => frame.type === "utterance_end")).toBe(false);
    expect(transcriber?.stopped).toBe(false);
    expect(turnCalls).toHaveLength(0);

    // ...and the resumed speech still routes into the same open utterance.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(
      () => (transcriber?.received.length ?? 0) > receivedBeforeResume,
      "The resumed speech stopped reaching the transcriber",
    );

    await session.close("client_end");
  });

  test("commits a fast turn-end for the still-open turn after a mid-thought pause", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      silenceThresholdMs: 40,
      emitMetrics: true,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    const transcriber = transcribers[0];
    transcriber?.startOfTurn(0);
    transcriber?.emit({ type: "partial", text: "what is the" });

    // A mid-thought pause, long enough for the local silence boundary to hand
    // the cycle to Flux, and then the caller keeps going.
    await sleep(PAST_SILENCE_BOUNDARY_MS);
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(
      () => countFrames(frames, "speech_started") === 2,
      "The resumed speech never re-opened a detector turn",
    );

    // Flux ends the turn it kept open across the pause, beating the next local
    // silence boundary: the fast commit this feature exists for. Nothing here
    // sleeps past that boundary, on purpose.
    const emittedAtMs = Date.now();
    transcriber?.endOfTurn("what is the weather today", 0);
    await waitFor(
      () => turnCalls.length === 1,
      "The fast turn-end after a mid-thought pause never committed",
    );
    const commitLatencyMs = Date.now() - emittedAtMs;

    // The fail-open budget is eotTimeoutMs (500 ms) plus the margin (1000 ms).
    // A commit anywhere near it means the turn-end was dropped and the
    // deadline committed in its place.
    expect(commitLatencyMs).toBeLessThan(300);
    expect(turnCalls[0]?.content).toBe("what is the weather today");
    // The Flux path, not the speculative hold path the deadline falls back to.
    expect(turnCalls[0]?.unifiedVerdict).toBeUndefined();
    expect(frames.some((frame) => frame.type === "utterance_end")).toBe(true);

    const metricsFrame = await waitForTurnMetrics(frames);
    expect(metricsFrame.endpointDecisionSource).toBe("provider");

    await session.close("client_end");
  });

  test("drops a turn-end for a turn flux has already superseded", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      silenceThresholdMs: 40,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    const transcriber = transcribers[0];
    transcriber?.startOfTurn(0);
    transcriber?.emit({ type: "partial", text: "what is the" });
    await sleep(PAST_SILENCE_BOUNDARY_MS);

    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(
      () => countFrames(frames, "speech_started") === 2,
      "The resumed speech never re-opened a detector turn",
    );
    const receivedBeforeResume = transcriber?.received.length ?? 0;

    // Flux closed turn 0 and opened turn 1 for the resumed speech, so the
    // end-of-turn for turn 0 trailing behind describes speech the caller has
    // moved past.
    transcriber?.startOfTurn(1);
    transcriber?.emit({
      type: "turn-end",
      text: "what is the",
      confidence: 0.9,
      turnIndex: 0,
    });
    await flushAsyncCallbacks();

    expect(frames.some((frame) => frame.type === "utterance_end")).toBe(false);
    expect(transcriber?.stopped).toBe(false);
    expect(turnCalls).toHaveLength(0);
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(
      () => (transcriber?.received.length ?? 0) > receivedBeforeResume,
      "The resumed speech stopped reaching the transcriber",
    );

    // Turn 1's own end-of-turn is the one that commits.
    transcriber?.endOfTurn("what is the weather today", 1);
    await waitFor(
      () => turnCalls.length === 1,
      "The superseding turn never committed",
    );
    expect(turnCalls[0]?.content).toBe("what is the weather today");
    expect(turnCalls[0]?.unifiedVerdict).toBeUndefined();

    await session.close("client_end");
  });

  test("commits the resumed turn on the next turn-end after dropping a stale one", async () => {
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      silenceThresholdMs: 40,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    await sleep(PAST_SILENCE_BOUNDARY_MS);

    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => countFrames(frames, "speech_started") === 2);
    transcribers[0]?.emit({
      type: "turn-end",
      text: "what is the",
      confidence: 0.9,
    });
    await flushAsyncCallbacks();
    expect(turnCalls).toHaveLength(0);

    // The caller finishes for real: the next silence boundary re-stamps the
    // cycle, so Flux's turn-end for the resumed speech commits it.
    await sleep(PAST_SILENCE_BOUNDARY_MS);
    transcribers[0]?.endOfTurn("what is the weather today");

    await waitFor(
      () => turnCalls.length === 1,
      "The resumed turn never committed after the stale turn-end was dropped",
    );
    expect(turnCalls[0]?.content).toBe("what is the weather today");
    expect(turnCalls[0]?.unifiedVerdict).toBeUndefined();
    expect(frames.some((frame) => frame.type === "utterance_end")).toBe(true);

    await session.close("client_end");
  });

  test("falls back to the deadline when nothing follows the dropped turn-end", async () => {
    const { session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      silenceThresholdMs: 40,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.emit({ type: "partial", text: "are you still there" });
    await sleep(PAST_SILENCE_BOUNDARY_MS);

    await session.handleBinaryAudio(LOUD_CHUNK);
    transcribers[0]?.emit({
      type: "turn-end",
      text: "are you still there",
      confidence: 0.9,
    });
    await flushAsyncCallbacks();
    expect(turnCalls).toHaveLength(0);

    // Flux says nothing more. The next silence boundary re-arms the fail-open
    // deadline, so the utterance still commits on the silence path instead of
    // hanging open forever.
    await waitFor(
      () => turnCalls.length === 1,
      "The utterance hung after the stale turn-end was dropped",
    );
    expect(turnCalls[0]?.content).toBe("are you still there");
    expect(turnCalls[0]?.unifiedVerdict).toBe(true);

    await session.close("client_end");
  }, 10_000);

  for (const flagOn of [false, true]) {
    test(`barge-in during playback fires from local VAD (flux turn end ${
      flagOn ? "on" : "off"
    })`, async () => {
      const streamTtsAudio = mock(async (ttsOptions: LiveVoiceTtsOptions) => {
        ttsOptions.onAudioChunk({
          type: "tts_audio",
          contentType: "audio/pcm",
          sampleRate: SAMPLE_RATE,
          dataBase64: Buffer.from("assistant audio").toString("base64"),
        });
        return {
          provider: "fish-audio",
          contentType: "audio/pcm",
          sampleRate: SAMPLE_RATE,
          chunks: 1,
          bytes: 15,
        } satisfies LiveVoiceTtsResult;
      });
      const { frames, session, transcribers } = createHarness({
        ...(flagOn ? { fluxConfig: FLUX_ON } : {}),
        silenceThresholdMs: 10_000,
        streamTtsAudio,
        // The leg never completes, so the turn is still in flight when the
        // caller speaks over it.
        startVoiceTurn: async (turnOptions) => {
          turnOptions.callbacks?.assistant_text_delta?.(
            makeTextDelta("Let me tell you a long story."),
          );
          return { turnId: "bridge-turn-1", abort: mock() };
        },
      });

      await session.start();
      await session.handleBinaryAudio(LOUD_CHUNK);
      await waitFor(() => transcribers.length > 0);
      if (flagOn) {
        transcribers[0]?.endOfTurn("tell me a story");
      } else {
        transcribers[0]?.emit({ type: "final", text: "tell me a story" });
        await session.handleClientFrame({ type: "ptt_release" });
      }
      await waitFor(() => frames.some((frame) => frame.type === "thinking"));

      // Local energy detection, not the provider's turn model, is what
      // interrupts the assistant.
      await session.handleBinaryAudio(SUSTAINED_LOUD_CHUNK);
      await waitFor(
        () => frames.some((frame) => frame.type === "speech_started"),
        "Local VAD barge-in never fired",
      );
      await waitFor(() =>
        frames.some((frame) => frame.type === "turn_cancelled"),
      );

      await session.close("client_end");
    });
  }
});

/**
 * The window between `ready` and the resolved transcriber. `start()` arms the
 * utterance in the background so the client's mic acquisition overlaps the STT
 * handshake, which means a fast caller can speak AND fall silent before the
 * dial answers. These tests seed `services.stt.provider` for real, because the
 * latch is armed from the configured provider before the dial and reconciled
 * with the resolved one after it.
 */
describe("LiveVoiceSession Flux end-of-turn during the STT dial", () => {
  beforeEach(() => {
    setConfig("services", {
      stt: { provider: "deepgram-flux", providers: {} },
    });
  });

  afterEach(() => {
    setConfig("services", { stt: { provider: "deepgram", providers: {} } });
  });

  test("waits for turn-end when the boundary lands before the dial resolves", async () => {
    const gate = createDialGate();
    const { frames, session, transcribers, turnCalls } = createHarness({
      fluxConfig: FLUX_ON,
      silenceThresholdMs: 40,
      resolveGate: gate.promise,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    expect(transcribers).toHaveLength(0);

    // The caller speaks and falls silent entirely inside the handshake
    // window, so the whole first turn is decided before any provider answers.
    await session.handleBinaryAudio(LOUD_CHUNK);
    await sleep(PAST_SILENCE_BOUNDARY_MS);

    // The silence boundary passed and committed nothing: the latch was seeded
    // from the configured provider, so Flux owns this boundary like any other.
    expect(transcribers).toHaveLength(0);
    expect(countFrames(frames, "utterance_end")).toBe(0);
    expect(turnCalls).toHaveLength(0);

    gate.open();
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.endOfTurn("what is the weather");

    await waitFor(
      () => turnCalls.length === 1,
      "The first utterance never committed on the Flux end-of-turn",
    );
    // Committed by Flux, not by the silence path: non-speculative dispatch.
    expect(turnCalls[0]?.content).toBe("what is the weather");
    expect(turnCalls[0]?.unifiedVerdict).toBeUndefined();
    expect(countFrames(frames, "utterance_end")).toBe(1);

    await session.close("client_end");
  });

  test("unwinds the seeded latch when the dial resolves to another provider", async () => {
    const gate = createDialGate();
    const { frames, session, transcribers, turnCalls } = createHarness({
      // Config names Flux, so the latch is seeded, but the dial answers with
      // another provider: a fallback, or a resolver reading a config the
      // session no longer matches. That provider never sends an end-of-turn.
      providerId: "deepgram",
      // Far enough out that the fail-open deadline alone cannot be what
      // releases this utterance inside the test's budget.
      fluxConfig: { turnEnd: { enabled: true }, eotTimeoutMs: 30_000 },
      silenceThresholdMs: 40,
      resolveGate: gate.promise,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);
    await sleep(PAST_SILENCE_BOUNDARY_MS);
    // Deferred under the seeded latch, exactly as a real Flux session would.
    expect(countFrames(frames, "utterance_end")).toBe(0);

    gate.open();
    await waitFor(() => transcribers.length > 0);

    // The deferred boundary is replayed as soon as the dial disproves the
    // seed, instead of being stranded on a deadline 30 s away.
    await waitFor(
      () => countFrames(frames, "utterance_end") === 1,
      "The utterance deferred under the seeded latch never released",
    );
    await waitFor(
      () => transcribers[0]?.stopped === true,
      "The utterance never finished releasing",
    );
    // ...and nothing routed through the Flux commit path.
    expect(turnCalls.every((call) => call.unifiedVerdict !== undefined)).toBe(
      true,
    );

    await session.close("client_end");
  });

  test("never seeds the latch when the flag is off", async () => {
    const gate = createDialGate();
    const { frames, session, transcribers, turnCalls } = createHarness({
      // No fluxConfig: `turnEnd.enabled` keeps its schema default of false
      // while config still names deepgram-flux as the provider.
      silenceThresholdMs: 40,
      resolveGate: gate.promise,
      startVoiceTurn: autoCompletingTurn(),
    });

    await session.start();
    await session.handleBinaryAudio(LOUD_CHUNK);

    // Unchanged from today: the silence boundary releases during the dial.
    await waitFor(
      () => countFrames(frames, "utterance_end") === 1,
      "The flag-off silence boundary stopped releasing during the dial",
    );
    expect(turnCalls).toHaveLength(0);

    gate.open();
    await waitFor(() => transcribers.length > 0);
    transcribers[0]?.endOfTurn("hello there");
    await flushAsyncCallbacks();

    // The turn-end commits nothing on top of the boundary that already ran.
    expect(countFrames(frames, "utterance_end")).toBe(1);

    await session.close("client_end");
  });
});
