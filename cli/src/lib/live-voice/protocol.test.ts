import { describe, expect, test } from "bun:test";

import { parseServerFrame } from "./protocol.js";

describe("parseServerFrame", () => {
  test("returns a handled frame with its fields intact", () => {
    const frame = parseServerFrame(
      JSON.stringify({
        type: "tts_audio",
        seq: 4,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      }),
    );

    expect(frame).toEqual({
      type: "tts_audio",
      seq: 4,
      mimeType: "audio/pcm",
      sampleRate: 24000,
      dataBase64: "AAAA",
    });
  });

  test("keeps fields a newer daemon adds to a known frame", () => {
    const frame = parseServerFrame(
      JSON.stringify({ type: "tts_done", seq: 5, turnId: "t1", extra: 1 }),
    );
    expect(frame).toHaveProperty("extra", 1);
  });

  test("names an unrecognized frame type rather than dropping it", () => {
    expect(
      parseServerFrame(JSON.stringify({ type: "some_future_frame", seq: 2 })),
    ).toEqual({ type: "unhandled", frameType: "some_future_frame" });
  });

  test("parses the capture-side frames a listening session needs", () => {
    for (const type of [
      "speech_started",
      "utterance_end",
      "utterance_discarded",
    ] as const) {
      expect(parseServerFrame(JSON.stringify({ type, seq: 1 }))).toEqual({
        type,
        seq: 1,
      });
    }
    expect(
      parseServerFrame(
        JSON.stringify({ type: "stt_partial", seq: 2, text: "hel" }),
      ),
    ).toEqual({ type: "stt_partial", seq: 2, text: "hel" });
  });

  test("never throws on malformed input", () => {
    expect(parseServerFrame("{oops")).toEqual({
      type: "malformed",
      raw: "{oops",
    });
    expect(parseServerFrame("null")).toEqual({
      type: "malformed",
      raw: "null",
    });
    expect(parseServerFrame(JSON.stringify({ seq: 1 }))).toEqual({
      type: "malformed",
      raw: '{"seq":1}',
    });
  });
});
