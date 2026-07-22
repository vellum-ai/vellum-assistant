import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  StreamingTranscriber,
  SttBoundaryId,
  SttProviderId,
} from "../stt/types.js";

// ---------------------------------------------------------------------------
// Mocks — declared before the subject import so the facade's lazy
// `await import()` calls resolve to these stand-ins.
// ---------------------------------------------------------------------------

let resolveCalls: unknown[] = [];
let resolveResult: StreamingTranscriber | null = null;

mock.module("../providers/speech-to-text/resolve.js", () => ({
  resolveStreamingTranscriber: (options: unknown) => {
    resolveCalls.push(options);
    return Promise.resolve(resolveResult);
  },
}));

// A tiny catalog: two providers, only one of which streams.
const STREAMING: SttBoundaryId = "daemon-streaming";
const CATALOG: Record<SttProviderId, Set<SttBoundaryId>> = {
  deepgram: new Set<SttBoundaryId>(["daemon-batch", "daemon-streaming"]),
  "openai-whisper": new Set<SttBoundaryId>(["daemon-batch"]),
  "google-gemini": new Set<SttBoundaryId>(["daemon-streaming"]),
  xai: new Set<SttBoundaryId>(["daemon-streaming"]),
  vellum: new Set<SttBoundaryId>(["daemon-streaming"]),
};

mock.module("../providers/speech-to-text/provider-catalog.js", () => ({
  listProviderIds: () => Object.keys(CATALOG) as SttProviderId[],
  supportsBoundary: (id: SttProviderId, boundary: SttBoundaryId) =>
    CATALOG[id]?.has(boundary) ?? false,
}));

const { openTranscriptionSession, listStreamingTranscriptionProviderIds } =
  await import("./transcription-session.js");

// A minimal session object standing in for a resolved transcriber.
function fakeSession(): StreamingTranscriber {
  return {
    providerId: "deepgram",
    boundaryId: "daemon-streaming",
    start: () => Promise.resolve(),
    sendAudio: () => {},
    stop: () => {},
  };
}

beforeEach(() => {
  resolveCalls = [];
  resolveResult = null;
});

describe("openTranscriptionSession", () => {
  test("returns the resolved streaming session", async () => {
    const session = fakeSession();
    resolveResult = session;

    const result = await openTranscriptionSession({ sampleRate: 16_000 });

    expect(result).toBe(session);
  });

  test("forwards supplied options to the resolver", async () => {
    resolveResult = fakeSession();

    await openTranscriptionSession({
      sampleRate: 16_000,
      diarize: "preferred",
      providerId: "deepgram",
    });

    expect(resolveCalls).toEqual([
      { sampleRate: 16_000, diarize: "preferred", providerId: "deepgram" },
    ]);
  });

  test("omits unset options rather than forwarding undefined", async () => {
    resolveResult = fakeSession();

    await openTranscriptionSession();

    expect(resolveCalls).toEqual([{}]);
  });

  test("returns null when no streaming session can be opened", async () => {
    resolveResult = null;

    const result = await openTranscriptionSession({ diarize: "required" });

    expect(result).toBeNull();
    // The unusable request still reached the resolver.
    expect(resolveCalls).toEqual([{ diarize: "required" }]);
  });
});

describe("listStreamingTranscriptionProviderIds", () => {
  test("lists only providers supporting the daemon-streaming boundary", async () => {
    const ids = await listStreamingTranscriptionProviderIds();

    expect(ids).toEqual(["deepgram", "google-gemini", "xai", "vellum"]);
    expect(ids).not.toContain("openai-whisper");
    // Sanity: the boundary constant is the one the facade filters on.
    expect(STREAMING).toBe("daemon-streaming");
  });
});
