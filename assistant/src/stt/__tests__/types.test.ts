import { describe, expect, test } from "bun:test";

import type {
  SttStreamServerClosedEvent,
  SttStreamServerEagerTurnEndEvent,
  SttStreamServerErrorEvent,
  SttStreamServerEvent,
  SttStreamServerFinalEvent,
  SttStreamServerPartialEvent,
  SttStreamServerTurnEndEvent,
  SttStreamServerTurnResumedEvent,
  SttStreamServerTurnStartEvent,
} from "../types.js";

// ---------------------------------------------------------------------------
// Type-shape assertions for the streaming server event discriminated union.
//
// These types are TypeScript interfaces (no runtime Zod schemas), so the
// "tests" below are primarily structural — they fail to compile if the
// interfaces change shape in a way that breaks an existing caller. The
// runtime assertions are intentionally light: they confirm the literal
// values round-trip unchanged through an assignment to the union type.
// ---------------------------------------------------------------------------

describe("SttStreamServerEvent types", () => {
  test("partial event compiles and round-trips without speakerLabel", () => {
    const event: SttStreamServerPartialEvent = {
      type: "partial",
      text: "hello",
    };
    const asUnion: SttStreamServerEvent = event;
    expect(asUnion.type).toBe("partial");
    expect(event.text).toBe("hello");
    expect(event.speakerLabel).toBeUndefined();
  });

  test("partial event accepts a speakerLabel when diarization is enabled", () => {
    const event: SttStreamServerPartialEvent = {
      type: "partial",
      text: "hello",
      speakerLabel: "0",
    };
    const asUnion: SttStreamServerEvent = event;
    expect(asUnion.type).toBe("partial");
    expect(event.speakerLabel).toBe("0");
  });

  test("final event compiles and round-trips without speakerLabel", () => {
    const event: SttStreamServerFinalEvent = {
      type: "final",
      text: "world",
    };
    const asUnion: SttStreamServerEvent = event;
    expect(asUnion.type).toBe("final");
    expect(event.text).toBe("world");
    expect(event.speakerLabel).toBeUndefined();
  });

  test("final event accepts a speakerLabel when diarization is enabled", () => {
    const event: SttStreamServerFinalEvent = {
      type: "final",
      text: "world",
      speakerLabel: "1",
    };
    const asUnion: SttStreamServerEvent = event;
    expect(asUnion.type).toBe("final");
    expect(event.speakerLabel).toBe("1");
  });

  test("error event has no speakerLabel field", () => {
    const event: SttStreamServerErrorEvent = {
      type: "error",
      category: "provider-error",
      message: "boom",
    };
    const asUnion: SttStreamServerEvent = event;
    expect(asUnion.type).toBe("error");
    // @ts-expect-error — speakerLabel is not part of SttStreamServerErrorEvent.
    const _label: string | undefined = event.speakerLabel;
    expect(_label).toBeUndefined();
  });

  test("closed event has no speakerLabel field", () => {
    const event: SttStreamServerClosedEvent = {
      type: "closed",
    };
    const asUnion: SttStreamServerEvent = event;
    expect(asUnion.type).toBe("closed");
    // @ts-expect-error — speakerLabel is not part of SttStreamServerClosedEvent.
    const _label: string | undefined = event.speakerLabel;
    expect(_label).toBeUndefined();
  });
});

describe("turn-detection server events", () => {
  test("turn-start event compiles and round-trips", () => {
    const event: SttStreamServerTurnStartEvent = { type: "turn-start" };
    const asUnion: SttStreamServerEvent = event;
    expect(asUnion.type).toBe("turn-start");
  });

  test("eager-turn-end event carries the speculated transcript", () => {
    const event: SttStreamServerEagerTurnEndEvent = {
      type: "eager-turn-end",
      text: "is this the end",
    };
    const asUnion: SttStreamServerEvent = event;
    expect(asUnion.type).toBe("eager-turn-end");
    expect(event.text).toBe("is this the end");
  });

  test("turn-resumed event compiles and round-trips", () => {
    const event: SttStreamServerTurnResumedEvent = { type: "turn-resumed" };
    const asUnion: SttStreamServerEvent = event;
    expect(asUnion.type).toBe("turn-resumed");
  });

  test("turn-end event carries the committed transcript and optional confidence", () => {
    const withoutConfidence: SttStreamServerTurnEndEvent = {
      type: "turn-end",
      text: "done speaking",
    };
    expect(withoutConfidence.confidence).toBeUndefined();

    const event: SttStreamServerTurnEndEvent = {
      type: "turn-end",
      text: "done speaking",
      confidence: 0.82,
    };
    const asUnion: SttStreamServerEvent = event;
    expect(asUnion.type).toBe("turn-end");
    expect(event.text).toBe("done speaking");
    expect(event.confidence).toBe(0.82);
  });

  test("a consumer switch over every variant is exhaustive", () => {
    // Fails to compile if a variant is added to SttStreamServerEvent
    // without a case here, which is what forces consumers to be revisited.
    const label = (event: SttStreamServerEvent): string => {
      switch (event.type) {
        case "partial":
        case "final":
        case "finalized":
        case "error":
        case "closed":
          return "transcript";
        case "turn-start":
        case "eager-turn-end":
        case "turn-resumed":
        case "turn-end":
          return "turn";
        default: {
          const _exhaustive: never = event;
          return _exhaustive;
        }
      }
    };

    const events: SttStreamServerEvent[] = [
      { type: "partial", text: "a" },
      { type: "final", text: "a" },
      { type: "finalized" },
      { type: "error", category: "provider-error", message: "boom" },
      { type: "closed" },
      { type: "turn-start" },
      { type: "eager-turn-end", text: "a" },
      { type: "turn-resumed" },
      { type: "turn-end", text: "a" },
    ];

    expect(events.map(label)).toEqual([
      "transcript",
      "transcript",
      "transcript",
      "transcript",
      "transcript",
      "turn",
      "turn",
      "turn",
      "turn",
    ]);
  });
});
