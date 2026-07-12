import { describe, expect, test } from "bun:test";

import {
  couldBeControlMarker,
  ESCALATE_MARKER,
  stripInternalSpeechMarkers,
} from "../voice-control-protocol.js";

describe("[ESCALATE] control marker", () => {
  test("marker constant is the expected token", () => {
    expect(ESCALATE_MARKER).toBe("[ESCALATE]");
  });

  test("stripInternalSpeechMarkers removes [ESCALATE] so it is never spoken", () => {
    expect(
      stripInternalSpeechMarkers("Let me think about that. [ESCALATE]").trim(),
    ).toBe("Let me think about that.");
  });

  test("stripping removes every [ESCALATE] occurrence", () => {
    expect(
      stripInternalSpeechMarkers("[ESCALATE] one [ESCALATE] two").replace(
        /\s+/g,
        " ",
      ),
    ).toBe(" one two");
  });

  test("couldBeControlMarker holds the complete marker (not flushed to TTS)", () => {
    expect(couldBeControlMarker("[ESCALATE]")).toBe(true);
  });

  test("couldBeControlMarker holds a partial marker still streaming", () => {
    // Any prefix of the marker must be held so a streamed "[ESCA" does not
    // leak to the TTS engine before the full marker arrives.
    for (const partial of ["[", "[ES", "[ESCAL", "[ESCALATE"]) {
      expect(couldBeControlMarker(partial)).toBe(true);
    }
  });

  test("ordinary text is not mistaken for the marker", () => {
    expect(couldBeControlMarker("Sure, one moment")).toBe(false);
    expect(stripInternalSpeechMarkers("Sure, one moment")).toBe(
      "Sure, one moment",
    );
  });
});
