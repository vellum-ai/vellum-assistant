import { describe, expect, mock, test } from "bun:test";

import type {
  VoiceTurnCallbacks,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import {
  LiveVoiceSession,
  type LiveVoiceTtsStreamer,
  type LiveVoiceTurnStarter,
} from "../live-voice-session.js";
import type { LiveVoiceSessionFactoryContext } from "../live-voice-session-manager.js";
import type { LiveVoiceTtsOptions } from "../live-voice-tts.js";
import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceClientStartFrame,
  type LiveVoiceServerFrame,
} from "../protocol.js";

const START_FRAME = {
  type: "start",
  conversationId: "conversation-123",
  audio: {
    mimeType: "audio/pcm",
    sampleRate: 24_000,
    channels: 1,
  },
} as const satisfies LiveVoiceClientStartFrame;

class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  stopped = false;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  constructor(private readonly stopEvents: SttStreamServerEvent[] = []) {}

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(): void {}

  stop(): void {
    this.stopped = true;
    for (const event of this.stopEvents) {
      this.emit(event);
    }
  }

  emit(event: SttStreamServerEvent): void {
    this.onEvent?.(event);
  }
}

function createContext(startFrame: LiveVoiceClientStartFrame = START_FRAME): {
  context: LiveVoiceSessionFactoryContext;
  frames: LiveVoiceServerFrame[];
} {
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];

  return {
    frames,
    context: {
      sessionId: "session-123",
      startFrame,
      sendFrame: mock(async (payload) => {
        const frame = sequencer.next(payload);
        frames.push(frame);
        return frame;
      }),
    },
  };
}

function createStartFrameWithoutConversationId(): LiveVoiceClientStartFrame {
  return {
    type: "start",
    audio: START_FRAME.audio,
  };
}

function createSessionHarness(
  options: {
    startFrame?: LiveVoiceClientStartFrame;
    transcriber?: MockStreamingTranscriber;
    startVoiceTurn?: LiveVoiceTurnStarter;
    createTurnId?: () => string;
    emitMetrics?: boolean;
    streamTtsAudio?: LiveVoiceTtsStreamer;
  } = {},
) {
  const transcriber =
    options.transcriber ??
    new MockStreamingTranscriber([
      { type: "final", text: "world" },
      { type: "closed" },
    ]);
  const { context, frames } = createContext(options.startFrame);
  const startVoiceTurn =
    options.startVoiceTurn ??
    mock(async () => ({ turnId: "bridge-turn-1", abort: mock() }));

  const session = new LiveVoiceSession(context, {
    resolveTranscriber: mock(async () => transcriber),
    startVoiceTurn,
    createTurnId: options.createTurnId ?? (() => "live-turn-1"),
    emitMetrics: options.emitMetrics ?? false,
    ...(options.streamTtsAudio
      ? { streamTtsAudio: options.streamTtsAudio }
      : {}),
  });

  return { frames, session, startVoiceTurn, transcriber };
}

async function waitForFrameCount(
  frames: LiveVoiceServerFrame[],
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20 && frames.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function flushAsyncCallbacks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(
  predicate: () => boolean,
  message = "Timed out waiting for live voice assistant turn condition",
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

/**
 * The most recent `activity` frame, or `undefined` when none has been sent.
 * `findLast` is past this project's lib target, so the filter-and-take-last
 * form stands in for it.
 */
function lastActivityFrame(
  frames: LiveVoiceServerFrame[],
): Extract<LiveVoiceServerFrame, { type: "activity" }> | undefined {
  const activity = frames.filter(
    (frame): frame is Extract<LiveVoiceServerFrame, { type: "activity" }> =>
      frame.type === "activity",
  );
  return activity[activity.length - 1];
}

function createCapturingTurnStarter(): {
  startVoiceTurn: LiveVoiceTurnStarter;
  getCallbacks: () => VoiceTurnCallbacks | undefined;
  announceApprovalPending: () => void;
  announceApprovalsResolved: () => void;
} {
  let callbacks: VoiceTurnCallbacks | undefined;
  let onApprovalPending: ((requestId: string) => void) | undefined;
  let onApprovalsResolved: (() => void) | undefined;
  const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
    callbacks = options.callbacks;
    onApprovalPending = options.onApprovalPending;
    onApprovalsResolved = options.onApprovalsResolved;
    return { turnId: "bridge-turn-1", abort: mock() };
  });
  return {
    startVoiceTurn,
    getCallbacks: () => callbacks,
    announceApprovalPending: () => onApprovalPending?.("req-1"),
    announceApprovalsResolved: () => onApprovalsResolved?.(),
  };
}

function createRecordingTtsStreamer(): {
  streamTtsAudio: LiveVoiceTtsStreamer;
  ttsTexts: string[];
} {
  const ttsTexts: string[] = [];
  const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
    ttsTexts.push(options.text);
    return {
      provider: "fish-audio" as const,
      contentType: "audio/pcm",
      sampleRate: 24_000,
      chunks: 1,
      bytes: Buffer.byteLength(options.text),
    };
  });
  return { streamTtsAudio, ttsTexts };
}

function emitTextDelta(
  getCallbacks: () => VoiceTurnCallbacks | undefined,
  text: string,
): void {
  getCallbacks()?.assistant_text_delta?.({
    type: "assistant_text_delta",
    text,
    conversationId: "conversation-123",
  });
}

function emitMessageComplete(
  getCallbacks: () => VoiceTurnCallbacks | undefined,
): void {
  getCallbacks()?.message_complete?.({
    type: "message_complete",
    conversationId: "conversation-123",
    messageId: "assistant-message-123",
  });
}

async function startReleasedTurn(
  session: LiveVoiceSession,
  getCallbacks: () => VoiceTurnCallbacks | undefined,
): Promise<void> {
  await session.start();
  await session.handleClientFrame({ type: "ptt_release" });
  await waitFor(() => getCallbacks() !== undefined);
}

function assistantDeltaTexts(frames: LiveVoiceServerFrame[]): string[] {
  return frames.flatMap((frame) =>
    frame.type === "assistant_text_delta" ? [frame.text] : [],
  );
}

describe("LiveVoiceSession assistant turn", () => {
  test("runs final transcripts through the voice bridge and forwards ordered assistant events", async () => {
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      options.callbacks?.assistant_text_delta?.({
        type: "assistant_text_delta",
        text: "Hello ",
        conversationId: options.conversationId,
      });
      options.callbacks?.assistant_text_delta?.({
        type: "assistant_text_delta",
        text: "there",
        conversationId: options.conversationId,
      });
      options.callbacks?.message_complete?.({
        type: "message_complete",
        conversationId: options.conversationId,
        messageId: "assistant-message-123",
      });
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const { frames, session, transcriber } = createSessionHarness({
      startVoiceTurn,
    });

    await session.start();
    transcriber.emit({ type: "final", text: "hello" });
    await session.handleClientFrame({ type: "ptt_release" });
    await waitForFrameCount(frames, 7);

    expect(startVoiceTurn).toHaveBeenCalledTimes(1);
    const voiceTurnOptions = startVoiceTurn.mock.calls[0]?.[0];
    expect(voiceTurnOptions).toMatchObject({
      conversationId: "conversation-123",
      voiceSessionId: "session-123",
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
      content: "hello world",
      isInbound: true,
    });
    expect(voiceTurnOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(frames.map((frame) => frame.type)).toEqual([
      "ready",
      "stt_final",
      "stt_final",
      "thinking",
      "assistant_text_delta",
      "assistant_text_delta",
      "tts_done",
    ]);
    expect(frames[3]).toMatchObject({
      type: "thinking",
      turnId: "live-turn-1",
    });
    expect(frames[4]).toMatchObject({
      type: "assistant_text_delta",
      text: "Hello ",
    });
    expect(frames[5]).toMatchObject({
      type: "assistant_text_delta",
      text: "there",
    });
    expect(frames[6]).toMatchObject({
      type: "tts_done",
      turnId: "live-turn-1",
    });
  });

  test("waits for transcriber closed before starting an assistant turn after release", async () => {
    const transcriber = new MockStreamingTranscriber();
    const startVoiceTurn = mock(async (_options: VoiceTurnOptions) => ({
      turnId: "bridge-turn-1",
      abort: mock(),
    }));
    const { frames, session } = createSessionHarness({
      transcriber,
      startVoiceTurn,
    });

    await session.start();
    transcriber.emit({ type: "final", text: "hello" });
    await waitForFrameCount(frames, 2);

    await session.handleClientFrame({ type: "ptt_release" });
    expect(transcriber.stopped).toBe(true);
    expect(startVoiceTurn).not.toHaveBeenCalled();

    transcriber.emit({ type: "final", text: "after release" });
    await waitForFrameCount(frames, 3);
    expect(startVoiceTurn).not.toHaveBeenCalled();

    transcriber.emit({ type: "closed" });
    await waitForFrameCount(frames, 4);

    expect(startVoiceTurn).toHaveBeenCalledTimes(1);
    expect(startVoiceTurn.mock.calls[0]?.[0]).toMatchObject({
      content: "hello after release",
    });
    expect(frames.map((frame) => frame.type)).toEqual([
      "ready",
      "stt_final",
      "stt_final",
      "thinking",
    ]);
  });

  test("empty transcripts finalize only after the transcriber closes", async () => {
    const transcriber = new MockStreamingTranscriber();
    const startVoiceTurn = mock(async (_options: VoiceTurnOptions) => ({
      turnId: "bridge-turn-1",
      abort: mock(),
    }));
    const { frames, session } = createSessionHarness({
      transcriber,
      startVoiceTurn,
      emitMetrics: true,
    });

    await session.start();
    await session.handleClientFrame({
      type: "audio",
      dataBase64: Buffer.from("user audio").toString("base64"),
    });
    await session.handleClientFrame({ type: "ptt_release" });

    transcriber.emit({ type: "final", text: "   \n\t  " });
    await waitForFrameCount(frames, 2);

    expect(startVoiceTurn).not.toHaveBeenCalled();
    expect(
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_cancelled",
      ),
    ).toBe(false);

    transcriber.emit({ type: "closed" });
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_cancelled",
      ),
    );

    expect(startVoiceTurn).not.toHaveBeenCalled();
    expect(frames.map((frame) => frame.type)).toEqual([
      "ready",
      "stt_final",
      "metrics",
    ]);
  });

  test("does not start an assistant turn for whitespace-only final transcripts", async () => {
    const transcriber = new MockStreamingTranscriber([
      { type: "final", text: "   \n\t  " },
      { type: "closed" },
    ]);
    const startVoiceTurn = mock(async (_options: VoiceTurnOptions) => ({
      turnId: "bridge-turn-1",
      abort: mock(),
    }));
    const { frames, session } = createSessionHarness({
      transcriber,
      startVoiceTurn,
    });

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });
    await waitForFrameCount(frames, 2);

    expect(startVoiceTurn).not.toHaveBeenCalled();
    expect(frames.map((frame) => frame.type)).toEqual(["ready", "stt_final"]);
  });

  test("falls back to the session id when start omits a conversation id", async () => {
    const startVoiceTurn = mock(async (_options: VoiceTurnOptions) => ({
      turnId: "bridge-turn-1",
      abort: mock(),
    }));
    const { frames, session } = createSessionHarness({
      startFrame: createStartFrameWithoutConversationId(),
      startVoiceTurn,
    });

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });
    await waitForFrameCount(frames, 3);

    expect(frames[0]).toMatchObject({
      type: "ready",
      conversationId: "session-123",
    });
    expect(startVoiceTurn.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "session-123",
    });
  });

  test("rejects audio while an assistant turn is in flight", async () => {
    const startVoiceTurn = mock(async (_options: VoiceTurnOptions) => ({
      turnId: "bridge-turn-1",
      abort: mock(),
    }));
    const { frames, session } = createSessionHarness({ startVoiceTurn });

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });
    await waitForFrameCount(frames, 3);
    expect(frames.map((frame) => frame.type)).toEqual([
      "ready",
      "stt_final",
      "thinking",
    ]);

    await session.handleBinaryAudio(new Uint8Array([7]));

    expect(startVoiceTurn).toHaveBeenCalledTimes(1);
    expect(frames.at(-1)).toMatchObject({
      type: "error",
      code: "invalid_audio_payload",
      message: "Live voice audio received after push-to-talk release.",
    });
  });

  test("publishes tool activity while the turn is running", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks = options.callbacks;
      return { turnId: "bridge-turn-1", abort: mock() };
    });
    const { frames, session } = createSessionHarness({ startVoiceTurn });

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });
    await waitForFrameCount(frames, 3);
    expect(frames.map((frame) => frame.type)).toEqual([
      "ready",
      "stt_final",
      "thinking",
    ]);

    callbacks?.tool_use_start?.("some_tool");
    await waitForFrameCount(frames, 4);

    // One activity frame, so a silent stretch of tool work is visible on the
    // surfaces that show the session. An unrecognized tool still gets a line.
    expect(frames.at(-1)).toMatchObject({
      type: "activity",
      label: "Working on it",
    });

    callbacks?.message_complete?.({
      type: "message_complete",
      conversationId: "conversation-123",
      messageId: "assistant-message-123",
    });
    await waitForFrameCount(frames, 6);
    expect(frames.map((frame) => frame.type)).toEqual([
      "ready",
      "stt_final",
      "thinking",
      "activity",
      "tts_done",
      // The turn is over, so the line clears: no surface should keep showing
      // the last tool it touched through the silence that follows.
      "activity",
    ]);
    expect(frames.at(-1)).toMatchObject({ type: "activity", label: "" });
  });

  test("interrupt aborts the in-flight turn and ignores late bridge events", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    let signal: AbortSignal | undefined;
    const abort = mock();
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      callbacks = options.callbacks;
      signal = options.signal;
      return { turnId: "bridge-turn-1", abort };
    });
    const { frames, session } = createSessionHarness({ startVoiceTurn });

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });
    await waitForFrameCount(frames, 3);

    await session.handleClientFrame({ type: "interrupt" });
    const frameCountAfterInterrupt = frames.length;
    callbacks?.assistant_text_delta?.({
      type: "assistant_text_delta",
      text: "late",
      conversationId: "conversation-123",
    });
    callbacks?.message_complete?.({
      type: "message_complete",
      conversationId: "conversation-123",
      messageId: "assistant-message-late",
    });
    await flushAsyncCallbacks();

    expect(signal?.aborted).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(frameCountAfterInterrupt);
    expect(frames.map((frame) => frame.type)).toEqual([
      "ready",
      "stt_final",
      "thinking",
    ]);
  });
});

describe("LiveVoiceSession room reveal", () => {
  function createMarkerHarness() {
    const { startVoiceTurn, getCallbacks } = createCapturingTurnStarter();
    const { streamTtsAudio, ttsTexts } = createRecordingTtsStreamer();
    const harness = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
    });
    return { ...harness, getCallbacks, ttsTexts };
  }

  /**
   * Harness for the leg that can actually put something on screen: routing
   * fronts every turn with the fast leg, so the front-door call is scripted to
   * escalate ("[1] Working on it.") and the returned callbacks drive the
   * ESCALATED leg; the toolless front door can never run a ui tool.
   */
  function createEscalatedMarkerHarness() {
    let escalatedCallbacks: VoiceTurnCallbacks | undefined;
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      if (options.routingLeg === "front-door") {
        queueMicrotask(() => {
          options.callbacks?.assistant_text_delta?.({
            type: "assistant_text_delta",
            text: "[1] Working on it.",
            conversationId: "conversation-123",
          });
          options.callbacks?.message_complete?.({
            type: "message_complete",
            conversationId: "conversation-123",
            messageId: "front-door-message",
          });
        });
        return { turnId: "bridge-turn-fd", abort: mock() };
      }
      escalatedCallbacks = options.callbacks;
      return { turnId: "bridge-turn-esc", abort: mock() };
    });
    const { streamTtsAudio, ttsTexts } = createRecordingTtsStreamer();
    const harness = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
    });
    return {
      ...harness,
      getCallbacks: () => escalatedCallbacks,
      ttsTexts,
    };
  }

  /** Run a ui tool to completion, as the agent loop would. */
  function runUiTool(
    getCallbacks: () => VoiceTurnCallbacks | undefined,
    toolName: string,
    opts?: { isError?: boolean },
  ): void {
    getCallbacks()?.tool_use_start?.(toolName);
    getCallbacks()?.tool_result?.({
      toolName,
      resultPreview: "",
      ...(opts?.isError === true ? { isError: true } : {}),
    });
  }

  // Showing a surface is what reveals the screen. Nothing the model says does,
  // so the user never loses the reveal to a forgotten token.
  test("a ui tool emits minimize_room after tts_done", async () => {
    const { frames, session, getCallbacks } = createEscalatedMarkerHarness();

    await startReleasedTurn(session, getCallbacks);
    runUiTool(getCallbacks, "ui_show");
    emitTextDelta(getCallbacks, "Here is the summary.");
    emitMessageComplete(getCallbacks);
    await waitFor(() => frames.some((frame) => frame.type === "minimize_room"));

    const ttsDoneIndex = frames.findIndex((frame) => frame.type === "tts_done");
    const minimizeIndex = frames.findIndex(
      (frame) => frame.type === "minimize_room",
    );
    expect(ttsDoneIndex).toBeGreaterThanOrEqual(0);
    // After the speech drains, never mid-sentence.
    expect(minimizeIndex).toBeGreaterThan(ttsDoneIndex);
    expect(frames[minimizeIndex]).toMatchObject({
      type: "minimize_room",
      turnId: "live-turn-1",
    });
    // At most once, however many surfaces the turn touched.
    expect(
      frames.filter((frame) => frame.type === "minimize_room"),
    ).toHaveLength(1);
  });

  // The reveal follows the surface, not the attempt: a rejected call (no
  // surface_type, an empty card, a client that never acks) rendered nothing,
  // and minimizing to show nothing is worse than staying put.
  test("a failed ui call reveals nothing", async () => {
    const { frames, session, getCallbacks } = createEscalatedMarkerHarness();

    await startReleasedTurn(session, getCallbacks);
    runUiTool(getCallbacks, "ui_show", { isError: true });
    emitTextDelta(getCallbacks, "I could not show that.");
    emitMessageComplete(getCallbacks);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(frames.some((frame) => frame.type === "minimize_room")).toBe(false);
  });

  test("a surface taken away before the reply ends reveals nothing", async () => {
    const { frames, session, getCallbacks } = createEscalatedMarkerHarness();

    await startReleasedTurn(session, getCallbacks);
    runUiTool(getCallbacks, "ui_show");
    runUiTool(getCallbacks, "ui_dismiss");
    emitTextDelta(getCallbacks, "Never mind, sorted it.");
    emitMessageComplete(getCallbacks);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(frames.some((frame) => frame.type === "minimize_room")).toBe(false);
  });

  // Opening an app puts something on screen just as a card does; a list keyed
  // on "ui_" would have missed it.
  test("opening an app reveals the screen", async () => {
    const { frames, session, getCallbacks } = createEscalatedMarkerHarness();

    await startReleasedTurn(session, getCallbacks);
    runUiTool(getCallbacks, "app_open");
    emitTextDelta(getCallbacks, "Opened it up.");
    emitMessageComplete(getCallbacks);
    await waitFor(() => frames.some((frame) => frame.type === "minimize_room"));

    expect(frames.some((frame) => frame.type === "minimize_room")).toBe(true);
  });

  // A blocked turn has no speech left to drain, and the card it is blocked on
  // renders behind the room. Waiting for a drain that is not coming would
  // leave the call silent in front of a decision the user cannot see.
  test("a pending approval reveals the screen immediately", async () => {
    const { startVoiceTurn, announceApprovalPending } =
      createCapturingTurnStarter();
    const { frames, session } = createSessionHarness({ startVoiceTurn });

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    announceApprovalPending();
    await waitFor(() => frames.some((frame) => frame.type === "minimize_room"));

    // Before any tts_done, unlike the drain-scoped reveal a shown surface gets.
    expect(frames.some((frame) => frame.type === "tts_done")).toBe(false);
  });

  // Every phrase progress narration has describes work in flight ("still on
  // it", "almost there"). While the turn is blocked on the user, all of them
  // are false, and the one that matters is the one about who is being waited
  // on.
  test("says it is waiting, once, and stops narrating progress", async () => {
    const {
      startVoiceTurn,
      announceApprovalPending,
      announceApprovalsResolved,
    } = createCapturingTurnStarter();
    const { streamTtsAudio, ttsTexts } = createRecordingTtsStreamer();
    const { frames, session } = createSessionHarness({
      startVoiceTurn,
      streamTtsAudio,
    });

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    announceApprovalPending();
    await waitFor(() => ttsTexts.join(" ").includes("okay"));
    // Repeat announcements do not repeat the line.
    announceApprovalPending();
    await flushAsyncCallbacks();

    const saidWaiting = ttsTexts.filter((text) => text.includes("okay")).length;
    expect(saidWaiting).toBe(1);

    announceApprovalsResolved();
    await flushAsyncCallbacks();
  });

  // `tool_use_start` fires before the approval gate blocks, so without this the
  // island keeps saying "Running a command" for the whole wait — a claim about
  // work in flight made at the one moment nothing is in flight. The request id
  // is what turns that line from accurate into answerable: it is what the Live
  // Activity's Approve and Deny send back.
  test("a pending approval publishes an answerable activity line", async () => {
    const { startVoiceTurn, getCallbacks, announceApprovalPending } =
      createCapturingTurnStarter();
    const { frames, session } = createSessionHarness({ startVoiceTurn });

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    getCallbacks()?.tool_use_start?.("bash");
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "activity" && frame.label.length > 0,
      ),
    );
    announceApprovalPending();
    await waitFor(() =>
      frames.some(
        (frame) =>
          frame.type === "activity" && frame.approvalRequestId === "req-1",
      ),
    );

    const waiting = lastActivityFrame(frames);
    // The tool's own phrase, kept, plus who is being waited on — so the line
    // beside the buttons names what is being approved without naming the tool
    // or its arguments to a Lock Screen.
    expect(waiting).toMatchObject({
      label: "Running a command — needs your okay",
      approvalRequestId: "req-1",
    });
  });

  // However the decision is made — the card in the app, the daemon's own
  // timeout, a superseding message — the buttons must go with it. They are
  // rendered from the id, so retiring the id is what retires them.
  test("resolving the approval retires the request id", async () => {
    const {
      startVoiceTurn,
      getCallbacks,
      announceApprovalPending,
      announceApprovalsResolved,
    } = createCapturingTurnStarter();
    const { frames, session } = createSessionHarness({ startVoiceTurn });

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    getCallbacks()?.tool_use_start?.("bash");
    announceApprovalPending();
    await waitFor(() =>
      frames.some(
        (frame) =>
          frame.type === "activity" && frame.approvalRequestId === "req-1",
      ),
    );

    announceApprovalsResolved();
    await waitFor(
      () => lastActivityFrame(frames)?.approvalRequestId === undefined,
    );

    const resumed = lastActivityFrame(frames);
    // Back to the tool that is now genuinely running, with nothing to answer.
    expect(resumed).toMatchObject({ label: "Running a command" });
    expect(resumed?.approvalRequestId).toBeUndefined();
  });

  // A turn can start and finish other work while it is blocked. Each of those
  // events republishes the activity line, and a republish composed as if
  // nothing were pending would take the request id down with it — retiring the
  // island's buttons while the turn was still waiting on them.
  test("a parallel tool event mid-wait does not retire the buttons", async () => {
    const { startVoiceTurn, getCallbacks, announceApprovalPending } =
      createCapturingTurnStarter();
    const { frames, session } = createSessionHarness({ startVoiceTurn });

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));

    getCallbacks()?.tool_use_start?.("bash");
    announceApprovalPending();
    await waitFor(() =>
      frames.some(
        (frame) =>
          frame.type === "activity" && frame.approvalRequestId === "req-1",
      ),
    );

    getCallbacks()?.tool_use_start?.("web_search");
    getCallbacks()?.tool_result?.({
      toolName: "web_search",
      resultPreview: "",
    });
    await flushAsyncCallbacks();

    const latest = lastActivityFrame(frames);
    expect(latest?.approvalRequestId).toBe("req-1");
    // And still naming the tool the decision is about, not the one that ran
    // alongside it.
    expect(latest?.label).toBe("Running a command — needs your okay");
  });

  test("dismissing a surface does not reveal the screen", async () => {
    const { frames, session, getCallbacks } = createEscalatedMarkerHarness();

    await startReleasedTurn(session, getCallbacks);
    runUiTool(getCallbacks, "ui_dismiss");
    emitTextDelta(getCallbacks, "Cleared that away.");
    emitMessageComplete(getCallbacks);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    // Minimizing to show the user something that is no longer there is the
    // opposite of the point.
    expect(frames.some((frame) => frame.type === "minimize_room")).toBe(false);
  });

  // The marker is no longer taught to any leg, so this is about a model that
  // emits one anyway: it must not be spoken, and it must not move the room.
  test("a terminal [-1] is stripped from deltas and TTS and reveals nothing", async () => {
    const { frames, session, getCallbacks, ttsTexts } =
      createEscalatedMarkerHarness();

    await startReleasedTurn(session, getCallbacks);
    emitTextDelta(getCallbacks, "hello world. [-1]");
    emitMessageComplete(getCallbacks);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    const joined = assistantDeltaTexts(frames).join("");
    expect(joined).toContain("hello world. ");
    expect(joined).not.toContain("[-1]");
    expect(ttsTexts.join(" ")).not.toContain("[-1]");
    expect(frames.some((frame) => frame.type === "minimize_room")).toBe(false);
  });

  test("holds a marker split across deltas and never leaks the partial", async () => {
    const { frames, session, getCallbacks, ttsTexts } =
      createEscalatedMarkerHarness();

    await startReleasedTurn(session, getCallbacks);
    emitTextDelta(getCallbacks, "One sec, done. [-");
    await flushAsyncCallbacks();
    expect(assistantDeltaTexts(frames).join("")).toContain("One sec, done. ");

    emitTextDelta(getCallbacks, "1]");
    emitMessageComplete(getCallbacks);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    const joined = assistantDeltaTexts(frames).join("");
    expect(joined).not.toContain("[-");
    expect(ttsTexts.join(" ")).not.toContain("[-");
  });

  test("a mid-reply [-1] is stripped from speech and never minimizes", async () => {
    const { frames, session, getCallbacks } = createMarkerHarness();

    await startReleasedTurn(session, getCallbacks);
    emitTextDelta(getCallbacks, "The array [-1] sorts first, then the rest.");
    emitMessageComplete(getCallbacks);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(assistantDeltaTexts(frames).join("")).toBe(
      "The array  sorts first, then the rest.",
    );
    expect(frames.some((frame) => frame.type === "minimize_room")).toBe(false);
  });

  test("does not emit minimize_room when the turn is interrupted before drain", async () => {
    const { frames, session, getCallbacks } = createEscalatedMarkerHarness();

    await startReleasedTurn(session, getCallbacks);
    runUiTool(getCallbacks, "ui_show");
    emitTextDelta(getCallbacks, "Showing you now.");
    await flushAsyncCallbacks();

    await session.handleClientFrame({ type: "interrupt" });
    emitMessageComplete(getCallbacks);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(frames.some((frame) => frame.type === "minimize_room")).toBe(false);
  });

  test("a turn that shows nothing emits no minimize_room frame", async () => {
    const { frames, session, getCallbacks } = createMarkerHarness();

    await startReleasedTurn(session, getCallbacks);
    emitTextDelta(getCallbacks, "Hello there.");
    emitMessageComplete(getCallbacks);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(assistantDeltaTexts(frames).join("")).toBe("Hello there.");
    expect(frames.some((frame) => frame.type === "minimize_room")).toBe(false);
  });

  test("strips a stray [END_CALL] from main-leg deltas and TTS", async () => {
    const { frames, session, getCallbacks, ttsTexts } = createMarkerHarness();

    await startReleasedTurn(session, getCallbacks);
    emitTextDelta(getCallbacks, "Bye now. [END_CALL]");
    emitMessageComplete(getCallbacks);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(assistantDeltaTexts(frames).join("")).toBe("Bye now. ");
    expect(ttsTexts.join(" ")).not.toContain("[END_CALL]");
    expect(frames.some((frame) => frame.type === "minimize_room")).toBe(false);
  });

  test("a held marker-like tail that never completes is emitted at completion", async () => {
    const { frames, session, getCallbacks } = createEscalatedMarkerHarness();

    await startReleasedTurn(session, getCallbacks);
    emitTextDelta(getCallbacks, "Score was [-");
    emitMessageComplete(getCallbacks);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(assistantDeltaTexts(frames).join("")).toContain("Score was [-");
    expect(frames.some((frame) => frame.type === "minimize_room")).toBe(false);
  });

  test("holds a guardian-approval marker whose JSON body contains brackets, then strips it whole", async () => {
    const { frames, session, getCallbacks, ttsTexts } = createMarkerHarness();

    await startReleasedTurn(session, getCallbacks);
    // The JSON body carries both a "]" inside a string value and a nested
    // array — neither may terminate the hold or mask the marker's start.
    emitTextDelta(
      getCallbacks,
      'Hold on. [ASK_GUARDIAN_APPROVAL: {"question": "ok]?", "options": ["a", "b"',
    );
    await flushAsyncCallbacks();
    expect(assistantDeltaTexts(frames).join("")).toBe("Hold on. ");

    emitTextDelta(getCallbacks, "]}] Anything else?");
    emitMessageComplete(getCallbacks);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    const joined = assistantDeltaTexts(frames).join("");
    expect(joined).not.toContain("ASK_GUARDIAN_APPROVAL");
    expect(joined).toContain("Anything else?");
    expect(ttsTexts.join(" ")).not.toContain("ASK_GUARDIAN_APPROVAL");
  });
});
