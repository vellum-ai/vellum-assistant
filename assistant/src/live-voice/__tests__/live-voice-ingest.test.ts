import { describe, expect, test } from "bun:test";

import type { ResolveStreamingTranscriberOptions } from "../../providers/speech-to-text/resolve.js";
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

/**
 * Plain-tier streaming mock: like openai-whisper, it emits its `final` only
 * at end-of-stream — `stop()` flushes the pending final and then closes.
 */
class MockPlainStreamingTranscriber extends MockStreamingTranscriber {
  constructor(private readonly finalOnStop: string) {
    super();
  }

  override stop(): void {
    super.stop();
    this.emit({ type: "final", text: this.finalOnStop });
    this.emit({ type: "closed" });
  }
}

class MockBatchTranscriber implements BatchTranscriber {
  readonly providerId = "openai-whisper" as const;
  readonly boundaryId = "daemon-batch" as const;
  readonly requests: SttTranscribeRequest[] = [];

  constructor(
    private readonly texts: string[] = [],
    private readonly delaysMs: number[] = [],
  ) {}

  async transcribe(
    request: SttTranscribeRequest,
  ): Promise<SttTranscribeResult> {
    const index = this.requests.length;
    this.requests.push(request);
    const delay = this.delaysMs[index] ?? 0;
    if (delay > 0) {
      await sleep(delay);
    }
    return { text: this.texts[index] ?? "transcript" };
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
      // Open-mic so the post-crash turn auto-ends on silence.
      config: { mode: "open-mic" },
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
      // Open-mic so turns auto-end on silence while streaming is pending.
      config: { mode: "open-mic" },
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

describe("LiveVoiceIngest mode semantics", () => {
  test("ptt: sustained silence after speech does not end the turn; forceTurnEnd does", async () => {
    const batch = new MockBatchTranscriber(["held utterance"]);
    const { events, ingest } = createIngest({
      config: { mode: "ptt" },
      deps: {
        resolveStreamingTranscriber: async () => null,
        resolveBatchTranscriber: async () => batch,
      },
    });

    ingest.start();
    await sleep(5);
    ingest.pushAudio(speechChunk());

    // Sustained silence well past the silence threshold while the user
    // keeps holding push-to-talk: no auto turn end, no final.
    for (let i = 0; i < 3; i++) {
      await sleep(SILENCE_THRESHOLD_MS + 20);
      ingest.pushAudio(quietChunk(1));
    }
    expect(events).not.toContain("turn-boundary");
    expect(events.filter((event) => event.startsWith("final:"))).toEqual([]);

    // Release ends the turn and both halves of the utterance transcribe.
    ingest.forceTurnEnd();
    await waitFor(() => events.includes("final:held utterance"));
    expect(events).toContain("turn-boundary");
    expect(batch.requests).toHaveLength(1);

    ingest.dispose();
  });

  test("open-mic: silence after speech ends the turn without forceTurnEnd", async () => {
    const batch = new MockBatchTranscriber(["hands free"]);
    const { events, ingest } = createIngest({
      config: { mode: "open-mic" },
      deps: {
        resolveStreamingTranscriber: async () => null,
        resolveBatchTranscriber: async () => batch,
      },
    });

    ingest.start();
    await sleep(5);
    ingest.pushAudio(speechChunk());

    await waitFor(() => events.includes("final:hands free"));
    expect(events).toContain("turn-boundary");

    ingest.dispose();
  });

  test("max-turn-duration cap ends the turn in both modes", async () => {
    for (const mode of ["ptt", "open-mic"] as const) {
      const batch = new MockBatchTranscriber([`${mode} capped`]);
      const { events, ingest } = createIngest({
        config: {
          mode,
          vad: {
            speechEnergyThreshold: 800,
            // High silence threshold proves the boundary comes from the cap.
            silenceThresholdMs: 10_000,
            maxTurnDurationMs: 40,
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

      await waitFor(() => events.includes(`final:${mode} capped`));
      expect(events).toContain("turn-boundary");

      ingest.dispose();
    }
  });
});

describe("LiveVoiceIngest two-tier streaming resolution", () => {
  test("uses the boundary tier when it resolves and never cycles the session per turn", async () => {
    const transcriber = new MockStreamingTranscriber();
    const calls: ResolveStreamingTranscriberOptions[] = [];
    const { ingest } = createIngest({
      deps: {
        resolveStreamingTranscriber: async (options) => {
          calls.push(options);
          return options.utteranceBoundaryFinals ? transcriber : null;
        },
      },
    });

    ingest.start();
    ingest.pushAudio(speechChunk());
    await waitFor(() => transcriber.sentChunks.length === 1);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.utteranceBoundaryFinals).toBe(true);
    expect(calls[0]?.sampleRate).toBe(SAMPLE_RATE);

    // Boundary tier: a turn end relies on provider utterance finals — the
    // provider session is not stopped/restarted.
    ingest.forceTurnEnd();
    await sleep(10);
    expect(transcriber.stopped).toBe(false);
    expect(calls).toHaveLength(1);

    ingest.dispose();
  });

  test("plain tier: partials flow and finals are forced per turn via stop/restart", async () => {
    const first = new MockPlainStreamingTranscriber("first turn");
    const second = new MockPlainStreamingTranscriber("second turn");
    const transcribers = [first, second];
    const calls: ResolveStreamingTranscriberOptions[] = [];
    const { events, ingest } = createIngest({
      deps: {
        resolveStreamingTranscriber: async (options) => {
          calls.push(options);
          if (options.utteranceBoundaryFinals) {
            return null;
          }
          return transcribers.shift() ?? null;
        },
        resolveBatchTranscriber: async () => {
          throw new Error("batch fallback must not be used in plain tier");
        },
      },
    });

    ingest.start();
    ingest.pushAudio(speechChunk());
    await waitFor(() => first.sentChunks.length === 1);

    // Live partials flow in the plain tier.
    first.emit({ type: "partial", text: "liv" });
    expect(events).toContain("partial:liv");

    // Turn end (PTT release) forces the utterance final by stopping the
    // provider session (which flushes its end-of-stream final).
    ingest.forceTurnEnd();
    expect(first.stopped).toBe(true);
    expect(events).toContain("final:first turn");

    // The next turn's audio reaches a fresh provider session and its
    // forced final arrives in order.
    ingest.pushAudio(speechChunk());
    await waitFor(() => second.sentChunks.length === 1);
    ingest.forceTurnEnd();
    await waitFor(() => events.includes("final:second turn"));
    expect(events.filter((event) => event.startsWith("final:"))).toEqual([
      "final:first turn",
      "final:second turn",
    ]);

    // Tier order: boundary attempted once up front, then plain; the two
    // per-turn restarts skip the boundary attempt.
    expect(calls.map((o) => Boolean(o.utteranceBoundaryFinals))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(events.filter((event) => event.startsWith("error:"))).toEqual([]);

    ingest.dispose();
  });

  test("falls back to batch only after both streaming tiers resolve null", async () => {
    const calls: ResolveStreamingTranscriberOptions[] = [];
    const batch = new MockBatchTranscriber(["batch final"]);
    const { events, ingest } = createIngest({
      deps: {
        resolveStreamingTranscriber: async (options) => {
          calls.push(options);
          return null;
        },
        resolveBatchTranscriber: async () => batch,
      },
    });

    ingest.start();
    await waitFor(() => calls.length === 2);
    expect(calls.map((o) => Boolean(o.utteranceBoundaryFinals))).toEqual([
      true,
      false,
    ]);

    ingest.pushAudio(speechChunk());
    ingest.forceTurnEnd();
    await waitFor(() => events.includes("final:batch final"));

    ingest.dispose();
  });
});

describe("LiveVoiceIngest batch turn ordering", () => {
  test("finals emit strictly in turn order even when the first transcription is slow", async () => {
    const batch = new MockBatchTranscriber(["first", "second"], [60, 0]);
    const { events, ingest } = createIngest({
      deps: {
        resolveStreamingTranscriber: async () => null,
        resolveBatchTranscriber: async () => batch,
      },
    });

    ingest.start();
    await sleep(5);

    ingest.pushAudio(speechChunk());
    ingest.forceTurnEnd();
    ingest.pushAudio(speechChunk());
    ingest.forceTurnEnd();

    await waitFor(
      () => events.filter((event) => event.startsWith("final:")).length === 2,
    );
    expect(events.filter((event) => event.startsWith("final:"))).toEqual([
      "final:first",
      "final:second",
    ]);

    ingest.dispose();
  });
});

describe("LiveVoiceIngest VAD and turn detection", () => {
  test("fires onSpeechStart exactly once per speech onset", async () => {
    const batch = new MockBatchTranscriber();
    const { events, ingest } = createIngest({
      // Open-mic so silence ends the first turn between the two onsets.
      config: { mode: "open-mic" },
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

  test("open-mic: fires onTurnBoundary after the silence threshold", async () => {
    const batch = new MockBatchTranscriber();
    const { events, ingest } = createIngest({
      config: { mode: "open-mic" },
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
