import { describe, expect, test } from "bun:test";

import { parseMediaStreamFrame } from "../calls/media-stream-parser.js";

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function makeStartFrame(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    event: "start",
    sequenceNumber: "1",
    streamSid: "MZ00000000000000000000000000000000",
    start: {
      accountSid: "AC00000000000000000000000000000000",
      streamSid: "MZ00000000000000000000000000000000",
      callSid: "CA00000000000000000000000000000000",
      tracks: ["inbound"],
      customParameters: { callSessionId: "test-session" },
      mediaFormat: {
        encoding: "audio/x-mulaw",
        sampleRate: 8000,
        channels: 1,
      },
    },
    ...overrides,
  });
}

function makeMediaFrame(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    event: "media",
    sequenceNumber: "2",
    streamSid: "MZ00000000000000000000000000000000",
    media: {
      track: "inbound",
      chunk: "1",
      timestamp: "100",
      payload: "dGVzdA==", // base64("test")
    },
    ...overrides,
  });
}

function makeDtmfFrame(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    event: "dtmf",
    sequenceNumber: "3",
    streamSid: "MZ00000000000000000000000000000000",
    dtmf: {
      digit: "5",
      duration: "100",
    },
    ...overrides,
  });
}

function makeMarkFrame(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    event: "mark",
    sequenceNumber: "4",
    streamSid: "MZ00000000000000000000000000000000",
    mark: {
      name: "end-of-speech",
    },
    ...overrides,
  });
}

function makeStopFrame(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    event: "stop",
    sequenceNumber: "5",
    streamSid: "MZ00000000000000000000000000000000",
    stop: {
      accountSid: "AC00000000000000000000000000000000",
      callSid: "CA00000000000000000000000000000000",
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Happy-path tests
// ---------------------------------------------------------------------------

describe("parseMediaStreamFrame — happy paths", () => {
  test("parses a valid start event", () => {
    const result = parseMediaStreamFrame(makeStartFrame());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.event.event).toBe("start");
    if (result.event.event !== "start") throw new Error("Expected start");
    expect(result.event.streamSid).toBe("MZ00000000000000000000000000000000");
    expect(result.event.start.callSid).toBe(
      "CA00000000000000000000000000000000",
    );
    expect(result.event.start.mediaFormat.encoding).toBe("audio/x-mulaw");
    expect(result.event.start.mediaFormat.sampleRate).toBe(8000);
    expect(result.event.start.mediaFormat.channels).toBe(1);
    expect(result.event.start.tracks).toEqual(["inbound"]);
    expect(result.event.start.customParameters).toEqual({
      callSessionId: "test-session",
    });
  });

  test("parses a valid start event with missing customParameters", () => {
    const raw = JSON.parse(makeStartFrame());
    delete raw.start.customParameters;
    const result = parseMediaStreamFrame(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    if (result.event.event !== "start") throw new Error("Expected start");
    expect(result.event.start.customParameters).toEqual({});
  });

  test("parses a valid media event", () => {
    const result = parseMediaStreamFrame(makeMediaFrame());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.event.event).toBe("media");
    if (result.event.event !== "media") throw new Error("Expected media");
    expect(result.event.media.track).toBe("inbound");
    expect(result.event.media.chunk).toBe("1");
    expect(result.event.media.timestamp).toBe("100");
    expect(result.event.media.payload).toBe("dGVzdA==");
  });

  test("parses a valid dtmf event", () => {
    const result = parseMediaStreamFrame(makeDtmfFrame());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.event.event).toBe("dtmf");
    if (result.event.event !== "dtmf") throw new Error("Expected dtmf");
    expect(result.event.dtmf.digit).toBe("5");
    expect(result.event.dtmf.duration).toBe("100");
  });

  test("parses a dtmf event without optional duration", () => {
    const raw = JSON.parse(makeDtmfFrame());
    delete raw.dtmf.duration;
    const result = parseMediaStreamFrame(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    if (result.event.event !== "dtmf") throw new Error("Expected dtmf");
    expect(result.event.dtmf.duration).toBeUndefined();
  });

  test("parses a valid mark event", () => {
    const result = parseMediaStreamFrame(makeMarkFrame());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.event.event).toBe("mark");
    if (result.event.event !== "mark") throw new Error("Expected mark");
    expect(result.event.mark.name).toBe("end-of-speech");
  });

  test("parses a valid stop event", () => {
    const result = parseMediaStreamFrame(makeStopFrame());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.event.event).toBe("stop");
    if (result.event.event !== "stop") throw new Error("Expected stop");
    expect(result.event.stop.accountSid).toBe(
      "AC00000000000000000000000000000000",
    );
    expect(result.event.stop.callSid).toBe(
      "CA00000000000000000000000000000000",
    );
  });
});

// ---------------------------------------------------------------------------
// Malformed frame tests
// ---------------------------------------------------------------------------

describe("parseMediaStreamFrame — malformed frames", () => {
  test("rejects non-JSON input", () => {
    const result = parseMediaStreamFrame("not json");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toBe("Invalid JSON");
  });

  test("rejects non-object JSON (array)", () => {
    const result = parseMediaStreamFrame("[1, 2, 3]");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toBe("Frame is not a JSON object");
  });

  test("rejects non-object JSON (string)", () => {
    const result = parseMediaStreamFrame('"hello"');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toBe("Frame is not a JSON object");
  });

  test("rejects non-object JSON (null)", () => {
    const result = parseMediaStreamFrame("null");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toBe("Frame is not a JSON object");
  });

  test("rejects frame without event field", () => {
    const result = parseMediaStreamFrame(JSON.stringify({ streamSid: "abc" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toBe("Missing or non-string 'event' field");
  });

  test("rejects frame with non-string event field", () => {
    const result = parseMediaStreamFrame(
      JSON.stringify({ event: 42, streamSid: "abc" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toBe("Missing or non-string 'event' field");
  });

  test("rejects unrecognised event type", () => {
    const result = parseMediaStreamFrame(
      JSON.stringify({ event: "connected", streamSid: "abc" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toContain("Unrecognised event type");
  });

  test("rejects start event missing streamSid", () => {
    const raw = JSON.parse(makeStartFrame());
    delete raw.streamSid;
    const result = parseMediaStreamFrame(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toContain("streamSid");
  });

  test("rejects start event missing start object", () => {
    const raw = JSON.parse(makeStartFrame());
    delete raw.start;
    const result = parseMediaStreamFrame(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toContain("start object");
  });

  test("rejects start event missing start.callSid", () => {
    const raw = JSON.parse(makeStartFrame());
    delete raw.start.callSid;
    const result = parseMediaStreamFrame(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toContain("callSid");
  });

  test("rejects start event missing mediaFormat", () => {
    const raw = JSON.parse(makeStartFrame());
    delete raw.start.mediaFormat;
    const result = parseMediaStreamFrame(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toContain("mediaFormat");
  });

  test("rejects start event with non-number sampleRate", () => {
    const raw = JSON.parse(makeStartFrame());
    raw.start.mediaFormat.sampleRate = "8000";
    const result = parseMediaStreamFrame(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toContain("sampleRate");
  });

  test("rejects start event with invalid tracks (not array)", () => {
    const raw = JSON.parse(makeStartFrame());
    raw.start.tracks = "inbound";
    const result = parseMediaStreamFrame(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toContain("tracks");
  });

  test("rejects media event missing media object", () => {
    const raw = JSON.parse(makeMediaFrame());
    delete raw.media;
    const result = parseMediaStreamFrame(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toContain("media object");
  });

  test("rejects media event missing media.payload", () => {
    const raw = JSON.parse(makeMediaFrame());
    delete raw.media.payload;
    const result = parseMediaStreamFrame(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toContain("payload");
  });

  test("rejects media event missing media.track", () => {
    const raw = JSON.parse(makeMediaFrame());
    delete raw.media.track;
    const result = parseMediaStreamFrame(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toContain("track");
  });

  test("rejects dtmf event missing dtmf object", () => {
    const raw = JSON.parse(makeDtmfFrame());
    delete raw.dtmf;
    const result = parseMediaStreamFrame(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toContain("dtmf object");
  });

  test("rejects dtmf event missing dtmf.digit", () => {
    const raw = JSON.parse(makeDtmfFrame());
    delete raw.dtmf.digit;
    const result = parseMediaStreamFrame(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toContain("digit");
  });

  test("rejects mark event missing mark object", () => {
    const raw = JSON.parse(makeMarkFrame());
    delete raw.mark;
    const result = parseMediaStreamFrame(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toContain("mark object");
  });

  test("rejects mark event missing mark.name", () => {
    const raw = JSON.parse(makeMarkFrame());
    delete raw.mark.name;
    const result = parseMediaStreamFrame(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toContain("mark.name");
  });

  test("rejects stop event missing stop object", () => {
    const raw = JSON.parse(makeStopFrame());
    delete raw.stop;
    const result = parseMediaStreamFrame(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toContain("stop object");
  });

  test("rejects stop event missing stop.callSid", () => {
    const raw = JSON.parse(makeStopFrame());
    delete raw.stop.callSid;
    const result = parseMediaStreamFrame(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toContain("callSid");
  });

  test("rejects stop event missing stop.accountSid", () => {
    const raw = JSON.parse(makeStopFrame());
    delete raw.stop.accountSid;
    const result = parseMediaStreamFrame(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toContain("accountSid");
  });
});
