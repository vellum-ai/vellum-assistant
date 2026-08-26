import { describe, expect, test } from "bun:test";

import {
  buildFluxQueryParams,
  fluxModelForLanguage,
  parseFluxFrame,
} from "../deepgram-flux-frames.js";

// ---------------------------------------------------------------------------
// Fixtures: one frame per documented Flux type
// ---------------------------------------------------------------------------

const CONNECTED = {
  type: "Connected",
  request_id: "req-123",
  sequence_id: 0,
};

const START_OF_TURN = {
  type: "TurnInfo",
  event: "StartOfTurn",
  request_id: "req-123",
  turn_index: 0,
  audio_window_start: 0,
  audio_window_end: 0.32,
  transcript: "",
  words: [],
};

const UPDATE = {
  type: "TurnInfo",
  event: "Update",
  turn_index: 0,
  transcript: "what is the",
  words: [
    { word: "what", confidence: 0.99, start: 0.1, end: 0.28 },
    { word: "is", confidence: 0.98, start: 0.28, end: 0.4 },
    { word: "the", confidence: 0.97, start: 0.4, end: 0.55 },
  ],
};

const EAGER_END_OF_TURN = {
  type: "TurnInfo",
  event: "EagerEndOfTurn",
  turn_index: 0,
  transcript: "what is the weather",
  end_of_turn_confidence: 0.42,
};

const TURN_RESUMED = {
  type: "TurnInfo",
  event: "TurnResumed",
  turn_index: 0,
};

const END_OF_TURN = {
  type: "TurnInfo",
  event: "EndOfTurn",
  turn_index: 0,
  transcript: "what is the weather today",
  end_of_turn_confidence: 0.88,
  words: [{ word: "today", confidence: 0.95, start: 1.1, end: 1.4 }],
};

const FATAL_ERROR = {
  type: "Error",
  sequence_id: 5,
  code: "INTERNAL_SERVER_ERROR",
  description: "An internal server error occurred while processing the request",
};

// ---------------------------------------------------------------------------
// parseFluxFrame
// ---------------------------------------------------------------------------

describe("parseFluxFrame", () => {
  test("Connected emits no events", () => {
    expect(parseFluxFrame(CONNECTED)).toEqual([]);
  });

  test("StartOfTurn emits turn-start carrying the turn index", () => {
    expect(parseFluxFrame(START_OF_TURN)).toEqual([
      { type: "turn-start", turnIndex: 0 },
    ]);
  });

  test("Update emits a partial with the interim transcript", () => {
    expect(parseFluxFrame(UPDATE)).toEqual([
      { type: "partial", text: "what is the" },
    ]);
  });

  test("a bare TurnInfo frame emits a partial transcript refresh", () => {
    expect(
      parseFluxFrame({ type: "TurnInfo", transcript: "partial text" }),
    ).toEqual([{ type: "partial", text: "partial text" }]);
  });

  test("EagerEndOfTurn emits eager-turn-end with the speculated text", () => {
    expect(parseFluxFrame(EAGER_END_OF_TURN)).toEqual([
      { type: "eager-turn-end", text: "what is the weather" },
    ]);
  });

  test("TurnResumed emits turn-resumed", () => {
    expect(parseFluxFrame(TURN_RESUMED)).toEqual([{ type: "turn-resumed" }]);
  });

  test("EndOfTurn emits final before turn-end", () => {
    const events = parseFluxFrame(END_OF_TURN);
    expect(events).toEqual([
      { type: "final", text: "what is the weather today" },
      {
        type: "turn-end",
        text: "what is the weather today",
        confidence: 0.88,
        turnIndex: 0,
      },
    ]);
    // Consumers that ignore turn events must still see the commit first.
    expect(events[0]?.type).toBe("final");
    expect(events[1]?.type).toBe("turn-end");
  });

  test("EndOfTurn omits confidence when Deepgram sends none", () => {
    expect(parseFluxFrame({ type: "EndOfTurn", transcript: "done" })).toEqual([
      { type: "final", text: "done" },
      { type: "turn-end", text: "done" },
    ]);
  });

  test("flat frames without a nested event field are accepted", () => {
    expect(parseFluxFrame({ type: "StartOfTurn" })).toEqual([
      { type: "turn-start" },
    ]);
    expect(parseFluxFrame({ type: "Update", transcript: "hi" })).toEqual([
      { type: "partial", text: "hi" },
    ]);
    expect(parseFluxFrame({ type: "TurnResumed" })).toEqual([
      { type: "turn-resumed" },
    ]);
  });

  test("JSON string payloads are parsed", () => {
    expect(parseFluxFrame(JSON.stringify(END_OF_TURN))).toEqual([
      { type: "final", text: "what is the weather today" },
      {
        type: "turn-end",
        text: "what is the weather today",
        confidence: 0.88,
        turnIndex: 0,
      },
    ]);
  });

  test("a later turn keeps its own index on both turn events", () => {
    expect(
      parseFluxFrame({ ...START_OF_TURN, turn_index: 3, transcript: "" }),
    ).toEqual([{ type: "turn-start", turnIndex: 3 }]);
    expect(
      parseFluxFrame({
        type: "TurnInfo",
        event: "EndOfTurn",
        turn_index: 3,
        transcript: "and then some",
      }),
    ).toEqual([
      { type: "final", text: "and then some" },
      { type: "turn-end", text: "and then some", turnIndex: 3 },
    ]);
  });

  test("turn events omit the index when Deepgram sends none", () => {
    expect(parseFluxFrame({ type: "StartOfTurn" })).toEqual([
      { type: "turn-start" },
    ]);
    expect(parseFluxFrame({ type: "EndOfTurn", transcript: "done" })).toEqual([
      { type: "final", text: "done" },
      { type: "turn-end", text: "done" },
    ]);
  });

  test("transcripts are trimmed and missing ones become empty strings", () => {
    expect(
      parseFluxFrame({ type: "Update", transcript: "  spaced  " }),
    ).toEqual([{ type: "partial", text: "spaced" }]);
    expect(parseFluxFrame({ type: "Update" })).toEqual([
      { type: "partial", text: "" },
    ]);
  });

  test("a fatal Error frame emits exactly one error event", () => {
    const events = parseFluxFrame(FATAL_ERROR);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      category: "provider-error",
      message:
        "Deepgram Flux error (INTERNAL_SERVER_ERROR): An internal server error occurred while processing the request",
    });
  });

  test("an Error frame preserves the provider description in the message", () => {
    const [event] = parseFluxFrame(
      JSON.stringify({
        type: "Error",
        code: "SOME_FUTURE_CODE",
        description: "something specific went wrong upstream",
      }),
    );
    expect(event?.type).toBe("error");
    expect((event as { message: string }).message).toContain(
      "something specific went wrong upstream",
    );
    expect((event as { message: string }).message).toContain(
      "SOME_FUTURE_CODE",
    );
  });

  test("Error frames are categorized from the provider code", () => {
    const categoryOf = (frame: Record<string, unknown>) => {
      const [event] = parseFluxFrame({ type: "Error", ...frame });
      return (event as { category?: string } | undefined)?.category;
    };

    expect(categoryOf({ code: "INVALID_AUTH" })).toBe("auth");
    expect(categoryOf({ code: "INSUFFICIENT_PERMISSIONS" })).toBe("auth");
    expect(categoryOf({ code: "TOO_MANY_REQUESTS" })).toBe("rate-limit");
    expect(categoryOf({ code: "REQUEST_TIMEOUT" })).toBe("timeout");
    expect(categoryOf({ code: "ASR_UNPROCESSABLE_ENTITY" })).toBe(
      "invalid-audio",
    );
    expect(categoryOf({ code: "INTERNAL_SERVER_ERROR" })).toBe(
      "provider-error",
    );
    // Unrecognized and bare error frames still surface, as provider-error.
    expect(categoryOf({ code: "SOMETHING_NEW" })).toBe("provider-error");
    expect(categoryOf({})).toBe("provider-error");
    // A complaint about eot_timeout_ms is a config error, not a transport
    // timeout, so the timeout matcher must not claim it.
    expect(
      categoryOf({
        code: "INVALID_EOT_TIMEOUT_MS",
        description: "eot_timeout_ms is out of range",
      }),
    ).toBe("provider-error");
  });

  test("an Error frame with no description still yields a usable message", () => {
    expect(parseFluxFrame({ type: "Error" })).toEqual([
      {
        type: "error",
        category: "provider-error",
        message: "Deepgram Flux error: no description provided",
      },
    ]);
  });

  test("unknown frame types emit nothing", () => {
    expect(parseFluxFrame({ type: "SomeFutureFrame", data: 1 })).toEqual([]);
    expect(
      parseFluxFrame({ type: "TurnInfo", event: "FutureTurnState" }),
    ).toEqual([]);
    // Only the documented fatal `Error` frame becomes an error event: an
    // unrecognized frame must never be reported as a stream failure, even
    // when it carries error-shaped fields.
    expect(
      parseFluxFrame({ type: "ConfigureFailure", code: "INVALID_AUTH" }),
    ).toEqual([]);
    expect(parseFluxFrame({ type: "error", description: "lowercase" })).toEqual(
      [],
    );
  });

  test("malformed and arbitrary input never throws and emits nothing", () => {
    const garbage: unknown[] = [
      undefined,
      null,
      0,
      1,
      Number.NaN,
      true,
      "",
      "not json",
      "{ broken json",
      "[]",
      "null",
      "42",
      [],
      [{ type: "EndOfTurn" }],
      {},
      { type: 7 },
      { type: null },
      { event: 7, type: 7 },
      new Date(),
      () => undefined,
      Symbol("x"),
      10n,
    ];
    for (const value of garbage) {
      expect(() => parseFluxFrame(value)).not.toThrow();
      expect(parseFluxFrame(value)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// buildFluxQueryParams
// ---------------------------------------------------------------------------

describe("buildFluxQueryParams", () => {
  test("builds the raw-audio parameter set", () => {
    const query = buildFluxQueryParams({
      model: "flux-general-en",
      encoding: "linear16",
      sampleRate: 16_000,
      eotThreshold: 0.7,
      eotTimeoutMs: 5_000,
    });
    const params = new URLSearchParams(query);
    expect(params.get("model")).toBe("flux-general-en");
    expect(params.get("encoding")).toBe("linear16");
    expect(params.get("sample_rate")).toBe("16000");
    expect(params.get("eot_threshold")).toBe("0.7");
    expect(params.get("eot_timeout_ms")).toBe("5000");
  });

  test("omits eager_eot_threshold when unset", () => {
    const query = buildFluxQueryParams({
      model: "flux-general-en",
      eotThreshold: 0.7,
      eotTimeoutMs: 5_000,
    });
    expect(query).not.toContain("eager_eot_threshold");
    expect(new URLSearchParams(query).has("eager_eot_threshold")).toBe(false);
  });

  test("passes eager_eot_threshold through when set", () => {
    const params = new URLSearchParams(
      buildFluxQueryParams({
        model: "flux-general-en",
        eagerEotThreshold: 0.5,
      }),
    );
    expect(params.get("eager_eot_threshold")).toBe("0.5");
  });

  test("omits encoding and sample_rate for containerized audio", () => {
    const params = new URLSearchParams(
      buildFluxQueryParams({ model: "flux-general-en" }),
    );
    expect(params.has("encoding")).toBe(false);
    expect(params.has("sample_rate")).toBe(false);
  });

  test("clamps thresholds and the timeout to the ranges Deepgram accepts", () => {
    const low = new URLSearchParams(
      buildFluxQueryParams({
        model: "flux-general-en",
        eotThreshold: 0.1,
        eagerEotThreshold: 0.05,
        eotTimeoutMs: 10,
      }),
    );
    expect(low.get("eot_threshold")).toBe("0.5");
    expect(low.get("eager_eot_threshold")).toBe("0.3");
    expect(low.get("eot_timeout_ms")).toBe("500");

    const high = new URLSearchParams(
      buildFluxQueryParams({
        model: "flux-general-en",
        eotThreshold: 5,
        eagerEotThreshold: 5,
        eotTimeoutMs: 999_999,
      }),
    );
    expect(high.get("eot_threshold")).toBe("0.9");
    expect(high.get("eager_eot_threshold")).toBe("0.9");
    expect(high.get("eot_timeout_ms")).toBe("60000");
  });

  test("clamps eager_eot_threshold down to eot_threshold", () => {
    const params = new URLSearchParams(
      buildFluxQueryParams({
        model: "flux-general-en",
        eotThreshold: 0.5,
        eagerEotThreshold: 0.9,
      }),
    );
    // Deepgram rejects the handshake when eager exceeds the final threshold.
    expect(Number(params.get("eager_eot_threshold"))).toBeLessThanOrEqual(
      Number(params.get("eot_threshold")),
    );
    expect(params.get("eager_eot_threshold")).toBe("0.5");
    expect(params.get("eot_threshold")).toBe("0.5");
  });

  test("clamps eager_eot_threshold against Deepgram's default when eot_threshold is unset", () => {
    const params = new URLSearchParams(
      buildFluxQueryParams({
        model: "flux-general-en",
        eagerEotThreshold: 0.9,
      }),
    );
    // No eot_threshold is sent, so the server default of 0.7 is in force.
    expect(params.has("eot_threshold")).toBe(false);
    expect(params.get("eager_eot_threshold")).toBe("0.7");
  });

  test("leaves an already-valid eager/eot pair untouched", () => {
    const params = new URLSearchParams(
      buildFluxQueryParams({
        model: "flux-general-en",
        eotThreshold: 0.9,
        eagerEotThreshold: 0.6,
      }),
    );
    expect(params.get("eot_threshold")).toBe("0.9");
    expect(params.get("eager_eot_threshold")).toBe("0.6");
  });

  test("the eager clamp never invents an eager_eot_threshold", () => {
    // Omitting the parameter is what disables eager turn-end speculation, so
    // the cross-threshold clamp must not fire when it is unset.
    for (const eotThreshold of [undefined, 0.5, 0.9]) {
      const query = buildFluxQueryParams({
        model: "flux-general-en",
        ...(eotThreshold !== undefined ? { eotThreshold } : {}),
      });
      expect(query).not.toContain("eager_eot_threshold");
      expect(new URLSearchParams(query).has("eager_eot_threshold")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// fluxModelForLanguage
// ---------------------------------------------------------------------------

describe("fluxModelForLanguage", () => {
  test("unset and English select the English model with no hint", () => {
    for (const language of [undefined, "", "en", "en-US", "EN"]) {
      expect(fluxModelForLanguage(language)).toEqual({
        model: "flux-general-en",
      });
    }
  });

  test("multi selects code-switching, which takes no hint", () => {
    // A hint would tell Flux the answer; omitting it is what asks it to
    // detect and follow a speaker between languages.
    expect(fluxModelForLanguage("multi")).toEqual({
      model: "flux-general-multi",
    });
  });

  test("a supported non-English language hints the multilingual model", () => {
    expect(fluxModelForLanguage("es")).toEqual({
      model: "flux-general-multi",
      languageHint: "es",
    });
    expect(fluxModelForLanguage("pt-BR")).toEqual({
      model: "flux-general-multi",
      languageHint: "pt",
    });
  });

  test("a language Flux cannot serve resolves to nothing", () => {
    // The caller refuses instead: the English model would return fluent
    // nonsense that the transcript gives no sign of.
    for (const language of ["ko", "zh", "ta", "sw"]) {
      expect(fluxModelForLanguage(language)).toBeNull();
    }
  });
});
