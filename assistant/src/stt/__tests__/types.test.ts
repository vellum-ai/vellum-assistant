import { describe, expect, test } from "bun:test";

import type {
  SttStreamServerClosedEvent,
  SttStreamServerErrorEvent,
  SttStreamServerEvent,
  SttStreamServerFinalEvent,
  SttStreamServerPartialEvent,
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
