import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { StreamingTranscriber } from "../stt/types.js";

// ---------------------------------------------------------------------------
// Mocks — declared before the subject import so the facade's static import of
// the resolver resolves to this stand-in.
// ---------------------------------------------------------------------------

let resolveCalls = 0;
let resolveResult: StreamingTranscriber | null = null;

mock.module("../providers/speech-to-text/resolve.js", () => ({
  resolveStreamingTranscriber: () => {
    resolveCalls++;
    return Promise.resolve(resolveResult);
  },
}));

const { openTranscriptionSession } = await import("./transcription-session.js");

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
  resolveCalls = 0;
  resolveResult = null;
});

describe("openTranscriptionSession", () => {
  test("returns the session resolved for the configured provider", async () => {
    const session = fakeSession();
    resolveResult = session;

    const result = await openTranscriptionSession();

    expect(result).toBe(session);
    expect(resolveCalls).toBe(1);
  });

  test("returns null when no streaming session can be opened", async () => {
    resolveResult = null;

    expect(await openTranscriptionSession()).toBeNull();
  });
});
