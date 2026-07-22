import { describe, expect, test } from "bun:test";

import {
  couldBeControlMarker,
  ESCALATE_VERDICT_TOKEN,
  HOLD_VERDICT_TOKEN,
  stripInternalSpeechMarkers,
} from "../voice-control-protocol.js";

describe("front-door verdict tokens", () => {
  test("token constants are the expected bracketed forms", () => {
    expect(HOLD_VERDICT_TOKEN).toBe("[0]");
    expect(ESCALATE_VERDICT_TOKEN).toBe("[1]");
  });

  test("stripInternalSpeechMarkers removes both tokens so they are never spoken", () => {
    expect(
      stripInternalSpeechMarkers("[1] Let me think about that.").trim(),
    ).toBe("Let me think about that.");
    expect(stripInternalSpeechMarkers("hey [0]").trim()).toBe("hey");
  });

  test("stripping removes every verdict-token occurrence", () => {
    expect(
      stripInternalSpeechMarkers("[1] one [1] two [0]").replace(/\s+/g, " "),
    ).toBe(" one two ");
  });

  test("couldBeControlMarker holds the complete tokens (not flushed to TTS)", () => {
    expect(couldBeControlMarker("[0]")).toBe(true);
    expect(couldBeControlMarker("[1]")).toBe(true);
  });

  test("couldBeControlMarker holds a partial token still streaming", () => {
    // Any prefix of a token must be held so a streamed "[1" does not leak
    // to the TTS engine before the full token arrives.
    for (const partial of ["[", "[0", "[1"]) {
      expect(couldBeControlMarker(partial)).toBe(true);
    }
  });

  test("ordinary text is not mistaken for a token", () => {
    expect(couldBeControlMarker("Sure, one moment")).toBe(false);
    expect(stripInternalSpeechMarkers("Sure, one moment")).toBe(
      "Sure, one moment",
    );
  });
});
