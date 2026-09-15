import { describe, expect, test } from "bun:test";

import {
  createControlMarkerHoldback,
  ESCALATE_VERDICT_TOKEN,
  HOLD_VERDICT_TOKEN,
  isIncompleteControlMarkerTail,
  MINIMIZE_ROOM_MARKER,
  parseTerminalSessionControl,
  type SessionControlRequest,
  stripInternalSpeechMarkers,
  terminalControlMarkerLength,
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

describe("session control markers", () => {
  test("strips untimed and timed mute markers", () => {
    expect(stripInternalSpeechMarkers("Muted. [MUTE]").trim()).toBe("Muted.");
    expect(stripInternalSpeechMarkers("Muted. [MUTE:30]").trim()).toBe(
      "Muted.",
    );
  });

  test("holds a streaming timed mute until its bracket arrives", () => {
    expect(isIncompleteControlMarkerTail("[MU")).toBe(true);
    expect(isIncompleteControlMarkerTail("[MUTE:3")).toBe(true);
    expect(isIncompleteControlMarkerTail("[MUTE:30]")).toBe(false);
    expect(isIncompleteControlMarkerTail("[UPDATES:FEW")).toBe(true);
    expect(isIncompleteControlMarkerTail("[UPDATES:FEWER]")).toBe(false);
    expect(isIncompleteControlMarkerTail("[LOOK:SCR")).toBe(true);
    expect(
      stripInternalSpeechMarkers("Taking a look. [LOOK:SCREEN]").trim(),
    ).toBe("Taking a look.");
  });

  test.each([
    ["Okay, talk soon. [END_CALL]", { action: "end" }],
    ["Muted. [MUTE]", { action: "mute" }],
    ["Taking a look. [LOOK:SCREEN]", { action: "look_screen" }],
    ["Show me. [LOOK:CAMERA]", { action: "look_camera" }],
    ["Okay, I'll stop looking. [LOOK:STOP]", { action: "look_stop" }],
    [
      "I'll check in less. [UPDATES:FEWER]",
      { action: "updates", cadence: "fewer" },
    ],
    [
      "Updates are back on. [UPDATES:NORMAL]",
      { action: "updates", cadence: "normal" },
    ],
    [
      "Muting for half a minute. [MUTE:30]  ",
      { action: "mute", durationMs: 30_000 },
    ],
    ["Muted. [MUTE: 1.5]", { action: "mute", durationMs: 1_500 }],
    // A garbled or oversized duration still mutes, just until unmuted.
    ["Muted. [MUTE:soon]", { action: "mute" }],
    ["Muted. [MUTE:0]", { action: "mute" }],
    ["Muted. [MUTE:99999]", { action: "mute" }],
  ] as Array<[string, SessionControlRequest]>)(
    "parses the terminal control in %j",
    (text, expected) => {
      expect(parseTerminalSessionControl(text)).toEqual(expected);
    },
  );

  test("a marker anywhere but the end controls nothing", () => {
    expect(
      parseTerminalSessionControl("Say [END_CALL] and I would hang up."),
    ).toBeNull();
    expect(parseTerminalSessionControl("No markers here.")).toBeNull();
  });

  test("measures the terminal marker the transcript pass strips", () => {
    expect(terminalControlMarkerLength("Done [-1]")).toBe(4);
    expect(terminalControlMarkerLength("Bye [END_CALL] ")).toBe(10);
    expect(terminalControlMarkerLength("Muted [MUTE:30]")).toBe(9);
    expect(terminalControlMarkerLength("Okay [UPDATES:FEWER]")).toBe(15);
    expect(terminalControlMarkerLength("The array [-1] sorts")).toBe(0);
  });
});
