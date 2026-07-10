import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { SttStreamServerEvent } from "../../../stt/types.js";

let transcribeCalls: Array<{ mimeType: string; source?: string }> = [];
let mockResult: unknown = { ok: true, value: { text: "", durationSeconds: 0 } };

mock.module("../../../platform/managed-speech.js", () => ({
  managedSpeechTranscribe: async (input: {
    mimeType: string;
    source?: string;
  }) => {
    transcribeCalls.push({ mimeType: input.mimeType, source: input.source });
    return mockResult;
  },
}));

import { VellumManagedStreamingTranscriber } from "../vellum-managed-stream.js";

async function collectSession(
  audio: Buffer,
  mimeType: string,
): Promise<SttStreamServerEvent[]> {
  const events: SttStreamServerEvent[] = [];
  const transcriber = new VellumManagedStreamingTranscriber({
    pollIntervalMs: 1,
  });
  await transcriber.start((event) => events.push(event));
  transcriber.sendAudio(audio, mimeType);
  // Let the poll fire before the final flush.
  await new Promise((resolve) => setTimeout(resolve, 20));
  transcriber.stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  return events;
}

describe("VellumManagedStreamingTranscriber", () => {
  beforeEach(() => {
    transcribeCalls = [];
    mockResult = {
      ok: true,
      value: { text: "hello world", durationSeconds: 1 },
    };
  });

  test("polls the platform and emits partial, final, closed", async () => {
    const events = await collectSession(Buffer.from([1, 2]), "audio/webm");

    expect(transcribeCalls.length).toBeGreaterThanOrEqual(1);
    expect(transcribeCalls[0].source).toBe("dictation-stream");
    expect(events.some((e) => e.type === "partial")).toBe(true);
    const final = events.find((e) => e.type === "final");
    expect(final && "text" in final && final.text).toBe("hello world");
    expect(events.at(-1)?.type).toBe("closed");
  });

  test("wraps PCM input in a WAV container before submitting", async () => {
    await collectSession(Buffer.alloc(64), "audio/pcm");
    expect(transcribeCalls[0].mimeType).toBe("audio/wav");
  });

  test("platform failures surface as normalized error events", async () => {
    mockResult = {
      ok: false,
      kind: "platform-error",
      status: 402,
      code: "insufficient_balance",
      message: "balance",
    };
    const events = await collectSession(Buffer.from([1]), "audio/webm");

    const error = events.find((e) => e.type === "error");
    expect(error && "message" in error && error.message).toContain(
      "Vellum credits",
    );
    // The contract still guarantees a final + closed even on failure.
    expect(events.some((e) => e.type === "final")).toBe(true);
    expect(events.at(-1)?.type).toBe("closed");
  });
});
