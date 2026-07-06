import { describe, expect, test } from "bun:test";

import type {
  BatchTranscriber,
  StreamingTranscriber,
  SttStreamServerEvent,
  SttTranscribeRequest,
  SttTranscribeResult,
} from "../../stt/types.js";
import {
  LiveVoiceIngest,
  type LiveVoiceIngestCallbacks,
  type LiveVoiceIngestConfig,
  type LiveVoiceIngestDeps,
} from "../live-voice-ingest.js";

const SAMPLE_RATE = 16_000;
const SILENCE_THRESHOLD_MS = 30;

class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  stopped = false;
  readonly sentChunks: { audio: Buffer; mimeType: string }[] = [];
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(audio: Buffer, mimeType: string): void {
    this.sentChunks.push({ audio, mimeType });
  }

  stop(): void {
    this.stopped = true;
  }

  emit(event: SttStreamServerEvent): void {
    this.onEvent?.(event);
  }
}

class MockBatchTranscriber implements BatchTranscriber {
  readonly providerId = "openai-whisper" as const;
  readonly boundaryId = "daemon-batch" as const;
  readonly requests: SttTranscribeRequest[] = [];

  constructor(private readonly texts: string[] = []) {}

  async transcribe(
    request: SttTranscribeRequest,
  ): Promise<SttTranscribeResult> {
    this.requests.push(request);
    return { text: this.texts[this.requests.length - 1] ?? "transcript" };
  }
}

/** PCM16 chunk whose mean amplitude exceeds the speech energy threshold. */
function speechChunk(samples = 320): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(8_000, i * 2);
  }
  return buf;
}

/** PCM16 chunk below the speech energy threshold, tagged for identification. */
function quietChunk(tag: number, samples = 320): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(tag, i * 2);
  }
  return buf;
}

function createIngest(
  options: {
    config?: Partial<LiveVoiceIngestConfig>;
    deps?: LiveVoiceIngestDeps;
    callbacks?: LiveVoiceIngestCallbacks;
  } = {},
) {
  const events: string[] = [];
  const ingest = new LiveVoiceIngest(
    {
      sampleRate: SAMPLE_RATE,
      mode: "ptt",
      vad: {
        speechEnergyThreshold: 800,
        silenceThresholdMs: SILENCE_THRESHOLD_MS,
        maxTurnDurationMs: 30_000,
      },
      ...options.config,
    },
    {
      onSpeechStart: () => events.push("speech-start"),
      onPartial: (text) => events.push(`partial:${text}`),
      onTranscriptFinal: (text) => events.push(`final:${text}`),
      onTurnBoundary: () => events.push("turn-boundary"),
      onError: (category, message) =>
        events.push(`error:${category}:${message}`),
      onStop: () => events.push("stop"),
      ...options.callbacks,
    },
    options.deps,
  );
  return { events, ingest };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  message = "Timed out waiting for live voice ingest condition",
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (predicate()) {
      return;
    }
    await sleep(5);
  }
  throw new Error(message);
}

describe("LiveVoiceIngest streaming mode", () => {
  test("forwards audio to the transcriber and partials/finals in order", async () => {
    const transcriber = new MockStreamingTranscriber();
    const { events, ingest } = createIngest({
      deps: { resolveStreamingTranscriber: async () => transcriber },
    });

    ingest.start();
    const chunk = speechChunk();
    ingest.pushAudio(chunk);
    await waitFor(() => transcriber.sentChunks.length === 1);

    expect(transcriber.sentChunks[0]?.mimeType).toBe(
      `audio/pcm;rate=${SAMPLE_RATE}`,
    );
    expect(transcriber.sentChunks[0]?.audio.equals(chunk)).toBe(true);

    transcriber.emit({ type: "partial", text: "hel" });
    transcriber.emit({ type: "partial", text: "hello wor" });
    transcriber.emit({ type: "final", text: "  hello world  " });
    transcriber.emit({ type: "final", text: "   " });

    expect(events).toEqual([
      "speech-start",
      "partial:hel",
      "partial:hello wor",
      "final:hello world",
    ]);

    ingest.dispose();
  });

  test("forceTurnEnd fires the turn boundary and provider finals still flow", async () => {
    const transcriber = new MockStreamingTranscriber();
    const { events, ingest } = createIngest({
      // High silence threshold proves the boundary comes from forceTurnEnd,
      // not the silence timer.
      config: {
        vad: {
          speechEnergyThreshold: 800,
          silenceThresholdMs: 10_000,
          maxTurnDurationMs: 30_000,
        },
      },
      deps: { resolveStreamingTranscriber: async () => transcriber },
    });

    ingest.start();
    ingest.pushAudio(speechChunk());
    await waitFor(() => transcriber.sentChunks.length > 0);

    ingest.forceTurnEnd();
    expect(events).toContain("turn-boundary");

    transcriber.emit({ type: "final", text: "released utterance" });
    expect(events).toContain("final:released utterance");

    ingest.dispose();
  });

  test("bounds the startup buffer, counts dropped chunks, and flushes the rest", async () => {
    let resolveTranscriber: (t: StreamingTranscriber | null) => void;
    const pending = new Promise<StreamingTranscriber | null>((resolve) => {
      resolveTranscriber = resolve;
    });
    const transcriber = new MockStreamingTranscriber();
    const { ingest } = createIngest({
      config: { streamingStartupBufferFrames: 3 },
      deps: { resolveStreamingTranscriber: () => pending },
    });

    ingest.start();
    for (let i = 1; i <= 5; i++) {
      ingest.pushAudio(quietChunk(i));
    }
    expect(ingest.streamingStartupFramesDropped).toBe(2);

    resolveTranscriber!(transcriber);
    await waitFor(() => transcriber.sentChunks.length === 3);

    // Oldest chunks (1, 2) were evicted; 3..5 flushed in order.
    expect(
      transcriber.sentChunks.map((sent) => sent.audio.readInt16LE(0)),
    ).toEqual([3, 4, 5]);

    ingest.dispose();
  });

  test("deliberate stop does not fall back to batch", async () => {
    const transcriber = new MockStreamingTranscriber();
    let batchResolved = 0;
    const { events, ingest } = createIngest({
      deps: {
        resolveStreamingTranscriber: async () => transcriber,
        resolveBatchTranscriber: async () => {
          batchResolved += 1;
          return new MockBatchTranscriber();
        },
      },
    });

    ingest.start();
    ingest.pushAudio(speechChunk());
    await waitFor(() => transcriber.sentChunks.length > 0);

    ingest.stop();
    expect(transcriber.stopped).toBe(true);
    expect(events).toContain("stop");

    // The provider close that follows a deliberate stop must not trigger
    // the batch fallback.
    transcriber.emit({ type: "closed" });
    ingest.pushAudio(speechChunk());
    ingest.forceTurnEnd();
    await sleep(20);

    expect(batchResolved).toBe(0);
    expect(events.filter((event) => event.startsWith("error:"))).toEqual([]);

    ingest.dispose();
  });
});

describe("LiveVoiceIngest batch fallback", () => {
  test("provider close mid-session falls back to batch and keeps producing finals", async () => {
    const transcriber = new MockStreamingTranscriber();
    const batch = new MockBatchTranscriber(["after the crash"]);
    const { events, ingest } = createIngest({
      deps: {
        resolveStreamingTranscriber: async () => transcriber,
        resolveBatchTranscriber: async () => batch,
      },
    });

    ingest.start();
    ingest.pushAudio(speechChunk());
    await waitFor(() => transcriber.sentChunks.length > 0);

    // Provider dies without a deliberate stop.
    transcriber.emit({ type: "closed" });

    ingest.pushAudio(speechChunk());
    await waitFor(() => events.includes("final:after the crash"));

    expect(batch.requests).toHaveLength(1);
    expect(batch.requests[0]?.mimeType).toBe("audio/wav");

    ingest.dispose();
  });

  test("resolver returning null settles batch mode and transcribes queued turns", async () => {
    let resolveTranscriber: (t: StreamingTranscriber | null) => void;
    const pending = new Promise<StreamingTranscriber | null>((resolve) => {
      resolveTranscriber = resolve;
    });
    const batch = new MockBatchTranscriber(["queued turn", "live turn"]);
    const { events, ingest } = createIngest({
      deps: {
        resolveStreamingTranscriber: () => pending,
        resolveBatchTranscriber: async () => batch,
      },
    });

    ingest.start();
    const chunk = speechChunk();
    ingest.pushAudio(chunk);
    // Let the silence timer complete the turn while streaming is pending.
    await waitFor(() => events.includes("turn-boundary"));

    resolveTranscriber!(null);
    await waitFor(() => events.includes("final:queued turn"));

    // The queued turn was WAV-wrapped PCM16 at the session sample rate.
    const request = batch.requests[0];
    expect(request?.mimeType).toBe("audio/wav");
    expect(request?.audio.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(request?.audio.readUInt32LE(24)).toBe(SAMPLE_RATE);
    expect(request?.audio.length).toBe(44 + chunk.length);

    // Turns after the fallback are batch-transcribed too.
    ingest.pushAudio(speechChunk());
    await waitFor(() => events.includes("final:live turn"));

    ingest.dispose();
  });

  test("forceTurnEnd transcribes the buffered turn immediately in batch mode", async () => {
    const batch = new MockBatchTranscriber(["forced final"]);
    const { events, ingest } = createIngest({
      // High silence threshold proves the final comes from forceTurnEnd,
      // not the silence timer.
      config: {
        vad: {
          speechEnergyThreshold: 800,
          silenceThresholdMs: 10_000,
          maxTurnDurationMs: 30_000,
        },
      },
      deps: {
        resolveStreamingTranscriber: async () => null,
        resolveBatchTranscriber: async () => batch,
      },
    });

    ingest.start();
    await sleep(5);
    ingest.pushAudio(speechChunk());
    ingest.pushAudio(speechChunk());
    ingest.forceTurnEnd();

    await waitFor(() => events.includes("final:forced final"));
    expect(events).toContain("turn-boundary");
    expect(batch.requests).toHaveLength(1);

    ingest.dispose();
  });

  test("surfaces an error when no batch transcriber is available", async () => {
    const { events, ingest } = createIngest({
      deps: {
        resolveStreamingTranscriber: async () => null,
        resolveBatchTranscriber: async () => null,
      },
    });

    ingest.start();
    await sleep(5);
    ingest.pushAudio(speechChunk());
    ingest.forceTurnEnd();

    await waitFor(() =>
      events.some((event) => event.startsWith("error:unconfigured")),
    );

    ingest.dispose();
  });
});

describe("LiveVoiceIngest VAD and turn detection", () => {
  test("fires onSpeechStart exactly once per speech onset", async () => {
    const batch = new MockBatchTranscriber();
    const { events, ingest } = createIngest({
      deps: {
        resolveStreamingTranscriber: async () => null,
        resolveBatchTranscriber: async () => batch,
      },
    });

    ingest.start();
    await sleep(5);

    ingest.pushAudio(speechChunk());
    ingest.pushAudio(speechChunk());
    ingest.pushAudio(speechChunk());
    expect(events.filter((event) => event === "speech-start")).toHaveLength(1);

    // Silence ends the turn; the next speech onset starts a new one.
    await waitFor(() => events.includes("turn-boundary"));
    ingest.pushAudio(speechChunk());
    expect(events.filter((event) => event === "speech-start")).toHaveLength(2);

    ingest.dispose();
  });

  test("fires onTurnBoundary after the silence threshold", async () => {
    const batch = new MockBatchTranscriber();
    const { events, ingest } = createIngest({
      deps: {
        resolveStreamingTranscriber: async () => null,
        resolveBatchTranscriber: async () => batch,
      },
    });

    ingest.start();
    await sleep(5);

    ingest.pushAudio(speechChunk());
    expect(events).not.toContain("turn-boundary");

    await waitFor(() => events.includes("turn-boundary"));
    expect(events.filter((event) => event === "turn-boundary")).toHaveLength(1);

    ingest.dispose();
  });
});
