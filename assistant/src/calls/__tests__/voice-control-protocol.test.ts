import { describe, expect, test } from "bun:test";

import {
  couldBeControlMarker,
  ESCALATE_VERDICT_TOKEN,
  HOLD_VERDICT_TOKEN,
  isIncompleteControlMarkerTail,
  MINIMIZE_ROOM_MARKER,
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

describe("minimize-room marker", () => {
  test("marker constant is the expected bracketed form", () => {
    expect(MINIMIZE_ROOM_MARKER).toBe("[-1]");
  });

  test("stripInternalSpeechMarkers removes the marker so it is never spoken", () => {
    expect(
      stripInternalSpeechMarkers("Done [-1] here").replace(/\s+/g, " "),
    ).toBe("Done here");
  });

  test("couldBeControlMarker holds the marker and its streaming prefixes", () => {
    for (const text of ["[", "[-", "[-1", "[-1]", "[-1] trailing"]) {
      expect(couldBeControlMarker(text)).toBe(true);
    }
  });

  test("a bracket prefix that disproves the marker is not held", () => {
    expect(couldBeControlMarker("[- something else")).toBe(false);
  });
});

describe("isIncompleteControlMarkerTail", () => {
  test("strict prefixes of any marker are incomplete", () => {
    for (const tail of ["[", "[-", "[-1", "[END_CAL", "[ASK_GUARDIAN_APPRO"]) {
      expect(isIncompleteControlMarkerTail(tail)).toBe(true);
    }
  });

  test("complete literal markers are not held", () => {
    for (const tail of ["[-1]", "[END_CALL]", "[0] answer", "[-1] look here"]) {
      expect(isIncompleteControlMarkerTail(tail)).toBe(false);
    }
  });

  test("guardian-approval is judged by the balanced parser, not the first bracket", () => {
    const streaming =
      '[ASK_GUARDIAN_APPROVAL: {"question": "ok]?", "options": ["a", "b"';
    expect(isIncompleteControlMarkerTail(streaming)).toBe(true);
    expect(isIncompleteControlMarkerTail(`${streaming}]}]`)).toBe(false);
  });

  test("colon-style markers terminate at their first bracket", () => {
    expect(isIncompleteControlMarkerTail("[ASK_GUARDIAN: may I")).toBe(true);
    expect(isIncompleteControlMarkerTail("[ASK_GUARDIAN: may I?]")).toBe(false);
    expect(isIncompleteControlMarkerTail("[USER_ANSWERED: yes")).toBe(true);
  });

  test("non-marker bracket text is not held", () => {
    for (const tail of ["[- something else", "[sic]", '["a", "b"]']) {
      expect(isIncompleteControlMarkerTail(tail)).toBe(false);
    }
  });
});
