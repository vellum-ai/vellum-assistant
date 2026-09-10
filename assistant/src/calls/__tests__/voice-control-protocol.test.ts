import { describe, expect, test } from "bun:test";

import {
  createControlMarkerHoldback,
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

  test("ordinary text is not mistaken for a token", () => {
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

describe("createControlMarkerHoldback", () => {
  function collect(): {
    flush: ReturnType<typeof createControlMarkerHoldback>;
    chunks: string[];
  } {
    const chunks: string[] = [];
    const flush = createControlMarkerHoldback((chunk) => chunks.push(chunk));
    return { flush, chunks };
  }

  test("holds a token still streaming and strips it once complete", () => {
    const { flush, chunks } = collect();
    flush("Sure [");
    expect(chunks).toEqual(["Sure "]);
    flush("Sure [1");
    expect(chunks).toEqual(["Sure "]);
    flush("Sure [1] one moment");
    expect(chunks).toEqual(["Sure ", " one moment"]);
  });

  test("ordinary bracketed text flushes without stalling", () => {
    const { flush, chunks } = collect();
    flush("Option [A] then [note] here");
    expect(chunks).toEqual(["Option [A] then [note] here"]);
  });

  test("a bracket prefix that disproves every marker flushes", () => {
    const { flush, chunks } = collect();
    flush("[- something else");
    expect(chunks).toEqual(["[- something else"]);
  });

  test("a guardian-approval body is held until its JSON balances", () => {
    const { flush, chunks } = collect();
    const streaming =
      'Hold on. [ASK_GUARDIAN_APPROVAL: {"question": "ok]?", "options": ["a", "b"';
    flush(streaming);
    expect(chunks).toEqual(["Hold on. "]);
    flush(`${streaming}]}] Thanks.`);
    expect(chunks).toEqual(["Hold on. ", " Thanks."]);
  });

  test("force emits a held tail that never became a marker", () => {
    const { flush, chunks } = collect();
    flush("Score was [1");
    expect(chunks).toEqual(["Score was "]);
    flush("Score was [1", { force: true });
    expect(chunks).toEqual(["Score was ", "[1"]);
  });

  test("a chunk that strips to nothing is not emitted", () => {
    const { flush, chunks } = collect();
    flush("[END_CALL]");
    expect(chunks).toEqual([]);
  });
});
