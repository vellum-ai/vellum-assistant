import { describe, expect, mock, test } from "bun:test";

mock.module("../../config/loader.js", () => ({
  loadConfig: () => ({
    ingress: { publicBaseUrl: "https://assistant.example.com" },
  }),
}));

import type { StreamingAudioHandle } from "../../calls/audio-store.js";
import {
  createAudioStoreSink,
  type SynthesisEmitChunk,
  synthesizeAndEmit,
} from "../synthesis-stream.js";
import type {
  TtsProvider,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const CAPABILITIES = { supportsStreaming: true, supportedFormats: ["mp3"] };

interface StreamingFakeOptions {
  /** Called between chunk deliveries so tests can abort/stale mid-stream. */
  betweenChunks?: (deliveredCount: number) => void;
  contentType?: string;
}

function makeStreamingProvider(
  chunks: Uint8Array[],
  options: StreamingFakeOptions = {},
): TtsProvider & { requests: TtsSynthesisRequest[] } {
  const requests: TtsSynthesisRequest[] = [];
  return {
    id: "fake-streaming",
    capabilities: CAPABILITIES,
    requests,
    synthesize(): Promise<TtsSynthesisResult> {
      throw new Error("buffer path should not be used");
    },
    async synthesizeStream(request, onChunk): Promise<TtsSynthesisResult> {
      requests.push(request);
      let delivered = 0;
      for (const chunk of chunks) {
        options.betweenChunks?.(delivered);
        onChunk(chunk);
        delivered += 1;
      }
      return {
        audio: Buffer.concat(chunks),
        contentType: options.contentType ?? "audio/mpeg",
      };
    },
  };
}

function makeBufferProvider(
  audio: Buffer,
  contentType = "audio/mpeg",
): TtsProvider & { requests: TtsSynthesisRequest[] } {
  const requests: TtsSynthesisRequest[] = [];
  return {
    id: "fake-buffer",
    capabilities: { supportsStreaming: false, supportedFormats: ["mp3"] },
    requests,
    async synthesize(request): Promise<TtsSynthesisResult> {
      requests.push(request);
      return { audio, contentType };
    },
  };
}

/** Records onFirstAudio/onChunk invocations in a single ordered log. */
function makeRecordingSink(): {
  events: string[];
  chunks: SynthesisEmitChunk[];
  onChunk: (chunk: SynthesisEmitChunk) => void;
  onFirstAudio: () => void;
} {
  const events: string[] = [];
  const chunks: SynthesisEmitChunk[] = [];
  return {
    events,
    chunks,
    onChunk(chunk) {
      events.push(`chunk:${chunk.audio.toString("utf8")}`);
      chunks.push(chunk);
    },
    onFirstAudio() {
      events.push("firstAudio");
    },
  };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

// ---------------------------------------------------------------------------
// synthesizeAndEmit — streaming path
// ---------------------------------------------------------------------------

describe("synthesizeAndEmit (streaming)", () => {
  test("emits chunks in order with onFirstAudio exactly once, before the first chunk", async () => {
    const provider = makeStreamingProvider([bytes("a"), bytes("b")]);
    const sink = makeRecordingSink();

    const result = await synthesizeAndEmit({
      provider,
      text: "hello",
      useCase: "phone-call",
      onChunk: sink.onChunk,
      onFirstAudio: sink.onFirstAudio,
    });

    expect(sink.events).toEqual(["firstAudio", "chunk:a", "chunk:b"]);
    expect(result).toEqual({ emittedChunks: 2, contentType: "audio/mpeg" });
  });

  test("skips empty chunks", async () => {
    const provider = makeStreamingProvider([
      new Uint8Array(0),
      bytes("a"),
      new Uint8Array(0),
      bytes("b"),
    ]);
    const sink = makeRecordingSink();

    const result = await synthesizeAndEmit({
      provider,
      text: "hello",
      useCase: "phone-call",
      onChunk: sink.onChunk,
      onFirstAudio: sink.onFirstAudio,
    });

    expect(sink.events).toEqual(["firstAudio", "chunk:a", "chunk:b"]);
    expect(result.emittedChunks).toBe(2);
  });

  test("throws when the stream completes with zero emitted chunks", async () => {
    const provider = makeStreamingProvider([new Uint8Array(0)]);
    const sink = makeRecordingSink();

    await expect(
      synthesizeAndEmit({
        provider,
        text: "hello",
        useCase: "phone-call",
        onChunk: sink.onChunk,
        onFirstAudio: sink.onFirstAudio,
      }),
    ).rejects.toThrow("Streaming TTS returned no audio chunks");
    expect(sink.events).toEqual([]);
  });

  test("abort mid-stream stops emission silently", async () => {
    // Delivery is synchronous, so chunk "a" is still queued (its sink call
    // has not started) when the abort fires — it must be suppressed too.
    const abortController = new AbortController();
    const provider = makeStreamingProvider(
      [bytes("a"), bytes("b"), bytes("c")],
      {
        betweenChunks(delivered) {
          if (delivered === 1) {
            abortController.abort();
          }
        },
      },
    );
    const sink = makeRecordingSink();

    const result = await synthesizeAndEmit({
      provider,
      text: "hello",
      useCase: "phone-call",
      signal: abortController.signal,
      onChunk: sink.onChunk,
      onFirstAudio: sink.onFirstAudio,
    });

    expect(sink.events).toEqual([]);
    expect(result.emittedChunks).toBe(0);
  });

  test("isCurrent() returning false mid-stream stops emission silently", async () => {
    let current = true;
    const provider = makeStreamingProvider(
      [bytes("a"), bytes("b"), bytes("c")],
      {
        betweenChunks(delivered) {
          if (delivered === 1) {
            current = false;
          }
        },
      },
    );
    const sink = makeRecordingSink();

    const result = await synthesizeAndEmit({
      provider,
      text: "hello",
      useCase: "phone-call",
      isCurrent: () => current,
      onChunk: sink.onChunk,
      onFirstAudio: sink.onFirstAudio,
    });

    expect(sink.events).toEqual([]);
    expect(result.emittedChunks).toBe(0);
  });

  test("abort while an async sink call is in flight suppresses queued chunks", async () => {
    const abortController = new AbortController();
    const provider = makeStreamingProvider([
      bytes("a"),
      bytes("b"),
      bytes("c"),
    ]);
    const events: string[] = [];
    const reached: string[] = [];

    const result = await synthesizeAndEmit({
      provider,
      text: "hello",
      useCase: "phone-call",
      signal: abortController.signal,
      onFirstAudio: () => events.push("firstAudio"),
      async onChunk(chunk) {
        reached.push(chunk.audio.toString("utf8"));
        events.push(`chunk:${chunk.audio.toString("utf8")}`);
        if (reached.length === 1) {
          // Barge-in mid-write: chunks "b" and "c" are already queued on the
          // emit chain and must not reach the sink.
          abortController.abort();
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      },
    });

    expect(reached).toEqual(["a"]);
    expect(events).toEqual(["firstAudio", "chunk:a"]);
    expect(result.emittedChunks).toBe(1);
  });

  test("isCurrent() flipping false while an async sink call is in flight suppresses queued chunks", async () => {
    let current = true;
    const provider = makeStreamingProvider([
      bytes("a"),
      bytes("b"),
      bytes("c"),
    ]);
    const reached: string[] = [];

    const result = await synthesizeAndEmit({
      provider,
      text: "hello",
      useCase: "phone-call",
      isCurrent: () => current,
      async onChunk(chunk) {
        reached.push(chunk.audio.toString("utf8"));
        if (reached.length === 1) {
          current = false;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      },
    });

    expect(reached).toEqual(["a"]);
    expect(result.emittedChunks).toBe(1);
  });

  test("isCurrent() false before the first chunk emits nothing and does not throw", async () => {
    const provider = makeStreamingProvider([bytes("a"), bytes("b")]);
    const sink = makeRecordingSink();

    const result = await synthesizeAndEmit({
      provider,
      text: "hello",
      useCase: "phone-call",
      isCurrent: () => false,
      onChunk: sink.onChunk,
      onFirstAudio: sink.onFirstAudio,
    });

    expect(sink.events).toEqual([]);
    expect(result.emittedChunks).toBe(0);
  });

  test("async onChunk sinks observe chunks in emission order", async () => {
    const provider = makeStreamingProvider([bytes("a"), bytes("b")]);
    const seen: string[] = [];

    await synthesizeAndEmit({
      provider,
      text: "hello",
      useCase: "phone-call",
      async onChunk(chunk) {
        // First chunk resolves last — ordering must still hold.
        await new Promise((resolve) =>
          setTimeout(resolve, seen.length === 0 ? 10 : 0),
        );
        seen.push(chunk.audio.toString("utf8"));
      },
    });

    expect(seen).toEqual(["a", "b"]);
  });

  test("a rejecting onChunk sink fails the call and stops further emits", async () => {
    const provider = makeStreamingProvider([bytes("a"), bytes("b")]);
    const attempted: string[] = [];

    await expect(
      synthesizeAndEmit({
        provider,
        text: "hello",
        useCase: "phone-call",
        onChunk(chunk) {
          attempted.push(chunk.audio.toString("utf8"));
          return Promise.reject(new Error("sink failed"));
        },
      }),
    ).rejects.toThrow("sink failed");
    expect(attempted).toEqual(["a"]);
  });

  test("provider errors propagate unmodified", async () => {
    const provider: TtsProvider = {
      id: "fake-throwing",
      capabilities: CAPABILITIES,
      synthesize: () => Promise.reject(new Error("unused")),
      synthesizeStream: () => Promise.reject(new Error("provider exploded")),
    };

    await expect(
      synthesizeAndEmit({
        provider,
        text: "hello",
        useCase: "phone-call",
        onChunk: () => {},
      }),
    ).rejects.toThrow("provider exploded");
  });

  test("passes text/useCase/voiceId/outputFormat/signal through on the request", async () => {
    const provider = makeStreamingProvider([bytes("a")]);
    const abortController = new AbortController();

    await synthesizeAndEmit({
      provider,
      text: "hello",
      useCase: "message-playback",
      voiceId: "voice-123",
      outputFormat: "pcm",
      signal: abortController.signal,
      onChunk: () => {},
    });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toEqual({
      text: "hello",
      useCase: "message-playback",
      voiceId: "voice-123",
      outputFormat: "pcm",
      signal: abortController.signal,
    });
  });
});

// ---------------------------------------------------------------------------
// synthesizeAndEmit — buffer path
// ---------------------------------------------------------------------------

describe("synthesizeAndEmit (buffer)", () => {
  test("emits the whole buffer as one chunk with the result contentType", async () => {
    const provider = makeBufferProvider(Buffer.from("abc"), "audio/wav");
    const sink = makeRecordingSink();

    const result = await synthesizeAndEmit({
      provider,
      text: "hello",
      useCase: "phone-call",
      onChunk: sink.onChunk,
      onFirstAudio: sink.onFirstAudio,
    });

    expect(sink.events).toEqual(["firstAudio", "chunk:abc"]);
    expect(sink.chunks[0]?.contentType).toBe("audio/wav");
    expect(result).toEqual({ emittedChunks: 1, contentType: "audio/wav" });
  });

  test("throws on an empty audio payload", async () => {
    const provider = makeBufferProvider(Buffer.alloc(0));
    const sink = makeRecordingSink();

    await expect(
      synthesizeAndEmit({
        provider,
        text: "hello",
        useCase: "phone-call",
        onChunk: sink.onChunk,
        onFirstAudio: sink.onFirstAudio,
      }),
    ).rejects.toThrow("Buffer TTS returned an empty audio payload");
    expect(sink.events).toEqual([]);
  });

  test("stale isCurrent() skips the emit silently", async () => {
    const provider = makeBufferProvider(Buffer.from("abc"));
    const sink = makeRecordingSink();

    const result = await synthesizeAndEmit({
      provider,
      text: "hello",
      useCase: "phone-call",
      isCurrent: () => false,
      onChunk: sink.onChunk,
      onFirstAudio: sink.onFirstAudio,
    });

    expect(sink.events).toEqual([]);
    expect(result.emittedChunks).toBe(0);
  });

  test("aborted signal skips the emit silently", async () => {
    const provider = makeBufferProvider(Buffer.from("abc"));
    const abortController = new AbortController();
    abortController.abort();
    const sink = makeRecordingSink();

    const result = await synthesizeAndEmit({
      provider,
      text: "hello",
      useCase: "phone-call",
      signal: abortController.signal,
      onChunk: sink.onChunk,
      onFirstAudio: sink.onFirstAudio,
    });

    expect(sink.events).toEqual([]);
    expect(result.emittedChunks).toBe(0);
  });

  test("passes the request through to synthesize", async () => {
    const provider = makeBufferProvider(Buffer.from("abc"));

    await synthesizeAndEmit({
      provider,
      text: "hello",
      useCase: "phone-call",
      voiceId: "voice-123",
      onChunk: () => {},
    });

    expect(provider.requests[0]).toEqual({
      text: "hello",
      useCase: "phone-call",
      voiceId: "voice-123",
      outputFormat: undefined,
      signal: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// createAudioStoreSink
// ---------------------------------------------------------------------------

interface FakeEntry extends StreamingAudioHandle {
  pushed: Uint8Array[];
  finalized: number;
}

function makeFakeEntry(audioId = "audio-123"): FakeEntry {
  const entry: FakeEntry = {
    audioId,
    pushed: [],
    finalized: 0,
    push(chunk) {
      entry.pushed.push(chunk);
    },
    finalize() {
      entry.finalized += 1;
    },
  };
  return entry;
}

describe("createAudioStoreSink", () => {
  test("sends the play URL exactly once and pushes chunks in order", () => {
    const entry = makeFakeEntry();
    const formats: string[] = [];
    const urls: string[] = [];
    const sink = createAudioStoreSink({
      format: "pcm",
      onPlayUrl: (url) => urls.push(url),
      createEntry: (format) => {
        formats.push(format);
        return entry;
      },
    });

    sink.onFirstAudio();
    sink.onChunk({ audio: Buffer.from("a"), contentType: "" });
    sink.onChunk({ audio: Buffer.from("b"), contentType: "" });

    expect(formats).toEqual(["pcm"]);
    expect(urls).toEqual(["https://assistant.example.com/v1/audio/audio-123"]);
    expect(entry.pushed.map((c) => Buffer.from(c).toString("utf8"))).toEqual([
      "a",
      "b",
    ]);
  });

  test("onChunk alone still sends the play URL once", () => {
    const entry = makeFakeEntry();
    const urls: string[] = [];
    const sink = createAudioStoreSink({
      format: "mp3",
      onPlayUrl: (url) => urls.push(url),
      createEntry: () => entry,
    });

    sink.onChunk({ audio: Buffer.from("a"), contentType: "" });
    sink.onChunk({ audio: Buffer.from("b"), contentType: "" });

    expect(urls).toHaveLength(1);
  });

  test("finalize marks the entry complete", () => {
    const entry = makeFakeEntry();
    const sink = createAudioStoreSink({
      format: "mp3",
      onPlayUrl: () => {},
      createEntry: () => entry,
    });

    sink.finalize();

    expect(entry.finalized).toBe(1);
  });

  test("defaults to the real streaming audio store", () => {
    const urls: string[] = [];
    const sink = createAudioStoreSink({
      format: "mp3",
      onPlayUrl: (url) => urls.push(url),
    });

    sink.onChunk({ audio: Buffer.from("a"), contentType: "" });
    sink.finalize();

    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(
      /^https:\/\/assistant\.example\.com\/v1\/audio\/[0-9a-f-]{36}$/,
    );
  });

  test("streams synthesizeAndEmit output into the store with finalize in finally", async () => {
    const entry = makeFakeEntry();
    const urls: string[] = [];
    const sink = createAudioStoreSink({
      format: "mp3",
      onPlayUrl: (url) => urls.push(url),
      createEntry: () => entry,
    });
    const provider = makeStreamingProvider([bytes("a"), bytes("b")]);

    try {
      await synthesizeAndEmit({
        provider,
        text: "hello",
        useCase: "phone-call",
        onChunk: sink.onChunk,
        onFirstAudio: sink.onFirstAudio,
      });
    } finally {
      sink.finalize();
    }

    expect(urls).toEqual(["https://assistant.example.com/v1/audio/audio-123"]);
    expect(entry.pushed.map((c) => Buffer.from(c).toString("utf8"))).toEqual([
      "a",
      "b",
    ]);
    expect(entry.finalized).toBe(1);
  });

  test("finalize still runs when synthesis fails before any audio", async () => {
    const entry = makeFakeEntry();
    const urls: string[] = [];
    const sink = createAudioStoreSink({
      format: "mp3",
      onPlayUrl: (url) => urls.push(url),
      createEntry: () => entry,
    });
    const provider = makeStreamingProvider([]);

    await expect(
      (async () => {
        try {
          await synthesizeAndEmit({
            provider,
            text: "hello",
            useCase: "phone-call",
            onChunk: sink.onChunk,
            onFirstAudio: sink.onFirstAudio,
          });
        } finally {
          sink.finalize();
        }
      })(),
    ).rejects.toThrow("Streaming TTS returned no audio chunks");
    expect(urls).toEqual([]);
    expect(entry.finalized).toBe(1);
  });
});
