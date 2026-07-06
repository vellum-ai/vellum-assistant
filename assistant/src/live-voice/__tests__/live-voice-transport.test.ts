import { describe, expect, mock, test } from "bun:test";

import type { LiveVoiceTtsStreamer } from "../live-voice-session.js";
import { LiveVoiceCallTransport } from "../live-voice-transport.js";
import type {
  LiveVoiceTtsAudioChunk,
  LiveVoiceTtsOptions,
  LiveVoiceTtsResult,
} from "../live-voice-tts.js";
import type { LiveVoiceServerFramePayload } from "../protocol.js";

function makeTtsChunk(
  text: string,
  contentType = "audio/pcm",
): LiveVoiceTtsAudioChunk {
  return {
    type: "tts_audio",
    contentType,
    sampleRate: 24_000,
    dataBase64: Buffer.from(text).toString("base64"),
  };
}

function makeTtsResult(
  text: string,
  contentType = "audio/pcm",
): LiveVoiceTtsResult {
  return {
    provider: "fish-audio",
    contentType,
    sampleRate: 24_000,
    chunks: 1,
    bytes: Buffer.byteLength(text),
  };
}

function createEchoStreamer(ttsTexts: string[]): LiveVoiceTtsStreamer {
  return mock(async (options: LiveVoiceTtsOptions) => {
    ttsTexts.push(options.text);
    options.onAudioChunk(makeTtsChunk(`audio:${options.text}`));
    return makeTtsResult(options.text);
  });
}

function createHarness(streamTtsAudio: LiveVoiceTtsStreamer) {
  const frames: LiveVoiceServerFramePayload[] = [];
  const sendFrame = mock(async (payload: LiveVoiceServerFramePayload) => {
    frames.push(payload);
  });
  const onSessionEnd = mock((_reason?: string) => {});
  const onTtsFailure = mock(() => {});
  const transport = new LiveVoiceCallTransport({
    sendFrame,
    streamTtsAudio,
    sampleRate: 24_000,
    turnId: () => "turn-1",
    onSessionEnd,
    onTtsFailure,
  });

  return { frames, onSessionEnd, onTtsFailure, sendFrame, transport };
}

async function waitFor(
  predicate: () => boolean,
  message = "Timed out waiting for live voice transport test condition",
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function flushAsyncCallbacks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("LiveVoiceCallTransport", () => {
  test("streams token segments as ordered tts_audio frames ending in tts_done", async () => {
    const ttsTexts: string[] = [];
    const { frames, transport } = createHarness(createEchoStreamer(ttsTexts));

    transport.sendTextToken("Hello ", false);
    transport.sendTextToken("there. And", false);
    await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));
    expect(frames.some((frame) => frame.type === "tts_done")).toBe(false);

    transport.sendTextToken(" more", true);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(ttsTexts).toEqual(["Hello there.", "And more"]);
    expect(frames.map((frame) => frame.type)).toEqual([
      "tts_audio",
      "tts_audio",
      "tts_done",
    ]);
    expect(frames[0]).toMatchObject({
      type: "tts_audio",
      mimeType: "audio/pcm",
      sampleRate: 24_000,
      dataBase64: Buffer.from("audio:Hello there.").toString("base64"),
    });
    expect(frames[1]).toMatchObject({
      dataBase64: Buffer.from("audio:And more").toString("base64"),
    });
    expect(frames.at(-1)).toEqual({ type: "tts_done", turnId: "turn-1" });
  });

  test("forwards non-PCM TTS chunk content type unchanged", async () => {
    const streamTtsAudio = mock(async (options: LiveVoiceTtsOptions) => {
      options.onAudioChunk(makeTtsChunk("wav audio", "audio/wav"));
      return makeTtsResult("wav audio", "audio/wav");
    });
    const { frames, transport } = createHarness(streamTtsAudio);

    transport.sendTextToken("Hello there.", true);
    await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));

    expect(frames.find((frame) => frame.type === "tts_audio")).toMatchObject({
      mimeType: "audio/wav",
      dataBase64: Buffer.from("wav audio").toString("base64"),
    });
  });

  test("synthesizes segments serially, not concurrently", async () => {
    const started: string[] = [];
    const resolvers: Array<(result: LiveVoiceTtsResult) => void> = [];
    const streamTtsAudio = mock(
      (options: LiveVoiceTtsOptions) =>
        new Promise<LiveVoiceTtsResult>((resolve) => {
          started.push(options.text);
          resolvers.push(resolve);
        }),
    );
    const { frames, transport } = createHarness(streamTtsAudio);

    transport.sendTextToken("One. Two.", true);
    await waitFor(() => started.length === 1);
    await flushAsyncCallbacks();

    expect(started).toEqual(["One."]);

    resolvers[0]?.(makeTtsResult("One."));
    await waitFor(() => started.length === 2);
    expect(started).toEqual(["One.", "Two."]);

    resolvers[1]?.(makeTtsResult("Two."));
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
  });

  test("fires the armed audio-start callback exactly once on the first chunk", async () => {
    const ttsTexts: string[] = [];
    const { frames, transport } = createHarness(createEchoStreamer(ttsTexts));
    const audioStart = mock(() => {});
    transport.setAudioStartCallback(audioStart);

    transport.sendTextToken("First one. Second one.", true);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(
      frames.filter((frame) => frame.type === "tts_audio").length,
    ).toBeGreaterThan(1);
    expect(audioStart).toHaveBeenCalledTimes(1);
  });

  test("re-arming the audio-start callback fires it for the next turn's audio", async () => {
    const ttsTexts: string[] = [];
    const { frames, transport } = createHarness(createEchoStreamer(ttsTexts));
    const firstTurnAudioStart = mock(() => {});
    transport.setAudioStartCallback(firstTurnAudioStart);

    transport.sendTextToken("Turn one.", true);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(firstTurnAudioStart).toHaveBeenCalledTimes(1);

    const secondTurnAudioStart = mock(() => {});
    transport.setAudioStartCallback(secondTurnAudioStart);
    transport.sendTextToken("Turn two.", true);
    await waitFor(
      () => frames.filter((frame) => frame.type === "tts_done").length === 2,
    );

    expect(firstTurnAudioStart).toHaveBeenCalledTimes(1);
    expect(secondTurnAudioStart).toHaveBeenCalledTimes(1);
  });

  test("passing null disarms the audio-start callback", async () => {
    const ttsTexts: string[] = [];
    const { frames, transport } = createHarness(createEchoStreamer(ttsTexts));
    const audioStart = mock(() => {});
    transport.setAudioStartCallback(audioStart);
    transport.setAudioStartCallback(null);

    transport.sendTextToken("Hello there.", true);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(audioStart).not.toHaveBeenCalled();
  });

  test("discardPendingText aborts in-flight synthesis and drops queued segments", async () => {
    let activeOptions: LiveVoiceTtsOptions | undefined;
    let resolveActive: ((result: LiveVoiceTtsResult) => void) | undefined;
    const streamTtsAudio = mock(
      (options: LiveVoiceTtsOptions) =>
        new Promise<LiveVoiceTtsResult>((resolve) => {
          activeOptions = options;
          resolveActive = resolve;
        }),
    );
    const { frames, transport } = createHarness(streamTtsAudio);
    const audioStart = mock(() => {});
    transport.setAudioStartCallback(audioStart);

    transport.sendTextToken("One. Two.", false);
    transport.sendTextToken(" buffered tail", false);
    await waitFor(() => activeOptions !== undefined);

    transport.discardPendingText();

    expect(activeOptions?.signal?.aborted).toBe(true);
    activeOptions?.onAudioChunk(makeTtsChunk("late audio"));
    resolveActive?.(makeTtsResult("late audio"));
    await flushAsyncCallbacks();

    expect(streamTtsAudio).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([]);
    expect(audioStart).not.toHaveBeenCalled();
    expect(transport.collectAssistantAudio()).toEqual([]);

    // The queue stays usable: a later end-of-turn signal only emits
    // tts_done — the discarded buffered tail never synthesizes.
    transport.sendTextToken("", true);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(streamTtsAudio).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([{ type: "tts_done", turnId: "turn-1" }]);
  });

  test("empty end-of-turn token emits only tts_done", async () => {
    const ttsTexts: string[] = [];
    const streamTtsAudio = createEchoStreamer(ttsTexts);
    const { frames, transport } = createHarness(streamTtsAudio);

    transport.sendTextToken("", true);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(streamTtsAudio).not.toHaveBeenCalled();
    expect(frames).toEqual([{ type: "tts_done", turnId: "turn-1" }]);
  });

  test("TTS failure surfaces via onTtsFailure and still reaches tts_done", async () => {
    const streamTtsAudio = mock(async () => {
      throw new Error("provider unavailable");
    });
    const { frames, onTtsFailure, transport } = createHarness(streamTtsAudio);

    transport.sendTextToken("This fails.", true);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(onTtsFailure).toHaveBeenCalledTimes(1);
    // The failure is reported to the session, never to the client directly.
    expect(frames).toEqual([{ type: "tts_done", turnId: "turn-1" }]);
  });

  test("discardPendingText suppresses tts_audio sends that were already chained", async () => {
    // Block the frame sink so a second chunk gets *chained* behind an
    // in-flight send before the barge-in lands.
    let releaseFirstSend!: () => void;
    const firstSendGate = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    const frames: LiveVoiceServerFramePayload[] = [];
    let sends = 0;
    const sendFrame = mock(async (payload: LiveVoiceServerFramePayload) => {
      sends += 1;
      if (sends === 1) {
        await firstSendGate;
      }
      frames.push(payload);
    });

    let activeOptions: LiveVoiceTtsOptions | undefined;
    let resolveActive: ((result: LiveVoiceTtsResult) => void) | undefined;
    const streamTtsAudio = mock(
      (options: LiveVoiceTtsOptions) =>
        new Promise<LiveVoiceTtsResult>((resolve) => {
          activeOptions = options;
          resolveActive = resolve;
        }),
    );
    const transport = new LiveVoiceCallTransport({
      sendFrame,
      streamTtsAudio,
      sampleRate: 24_000,
      turnId: () => "turn-1",
      onSessionEnd: () => {},
      onTtsFailure: () => {},
    });

    transport.sendTextToken("First one.", true);
    await waitFor(() => activeOptions !== undefined);
    // Two chunks: the first send blocks; the second is chained behind it.
    activeOptions?.onAudioChunk(makeTtsChunk("chunk-1"));
    activeOptions?.onAudioChunk(makeTtsChunk("chunk-2"));
    await waitFor(() => sends === 1);

    transport.discardPendingText();
    releaseFirstSend();
    resolveActive?.(makeTtsResult("First one."));
    await flushAsyncCallbacks();

    // The in-flight first chunk completes, but the chained second chunk
    // rechecks the abort and never reaches the sink — and neither does
    // the aborted turn's tts_done.
    expect(frames.filter((frame) => frame.type === "tts_audio")).toHaveLength(
      1,
    );
    expect(frames.some((frame) => frame.type === "tts_done")).toBe(false);
  });

  test("collectAssistantAudio returns emitted chunks once and resets", async () => {
    const ttsTexts: string[] = [];
    const { frames, transport } = createHarness(createEchoStreamer(ttsTexts));

    transport.sendTextToken("First one. Second one.", true);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    const collected = transport.collectAssistantAudio();
    expect(collected.map((chunk) => chunk.toString())).toEqual([
      "audio:First one.",
      "audio:Second one.",
    ]);
    expect(transport.collectAssistantAudio()).toEqual([]);
  });

  test("endSession invokes onSessionEnd with the reason", () => {
    const { onSessionEnd, transport } = createHarness(createEchoStreamer([]));

    transport.endSession("Maximum call duration reached");

    expect(onSessionEnd).toHaveBeenCalledTimes(1);
    expect(onSessionEnd).toHaveBeenCalledWith("Maximum call duration reached");
  });

  test("sendPlayUrl is a no-op that does not throw", () => {
    const { frames, transport } = createHarness(createEchoStreamer([]));

    expect(() => {
      transport.sendPlayUrl("https://example.com/audio.wav");
    }).not.toThrow();
    expect(frames).toEqual([]);
  });
});
