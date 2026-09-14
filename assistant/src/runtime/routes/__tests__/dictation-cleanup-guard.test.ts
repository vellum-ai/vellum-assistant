/**
 * The dictation cleanup pass rewrites what the user actually said, so a
 * rewrite the provider cut off at the token cap must never become the
 * payload: the raw transcript is sent instead.
 */

import { describe, expect, test } from "bun:test";

import {
  computeMaxTokens,
  resolveCleanedDictation,
} from "../diagnostics-routes.js";

const SPOKEN =
  "Hello Quill can you generate a list of 20 open HR coordinator or HR " +
  "related roles that are remote and pay about 50 to 60 K per year";

describe("resolveCleanedDictation", () => {
  test("accepts an ordinary cleanup", () => {
    const cleaned =
      "Hello Quill, can you generate a list of 20 open HR coordinator or HR " +
      "related roles that are remote and pay about 50 to 60K per year?";
    expect(resolveCleanedDictation(SPOKEN, cleaned, "end_turn")).toEqual({
      text: cleaned,
      rejected: null,
    });
  });

  test("trims surrounding whitespace off an accepted cleanup", () => {
    const { text } = resolveCleanedDictation(
      "so um I think we should ship the thing on Tuesday you know",
      "  I think we should ship the thing on Tuesday.  ",
      "end_turn",
    );
    expect(text).toBe("I think we should ship the thing on Tuesday.");
  });

  test("rejects a rewrite cut off by max_tokens and keeps the raw words", () => {
    expect(
      resolveCleanedDictation(
        SPOKEN,
        "Hello Quill, can you create a list",
        "max_tokens",
      ),
    ).toEqual({ text: SPOKEN, rejected: "truncated" });
  });

  test("rejects a max_tokens rewrite even when it kept most of the words", () => {
    const nearlyComplete = SPOKEN.slice(0, SPOKEN.length - 4);
    const { rejected } = resolveCleanedDictation(
      SPOKEN,
      nearlyComplete,
      "max_tokens",
    );
    expect(rejected).toBe("truncated");
  });

  test("rejects the token-cap stop under every provider's name for it", () => {
    for (const stopReason of ["length", "max_output_tokens", "MAX_TOKENS "]) {
      expect(
        resolveCleanedDictation(SPOKEN, "Hello Quill, can you", stopReason)
          .rejected,
      ).toBe("truncated");
    }
  });

  test("a missing stop reason is not treated as a truncation", () => {
    const cleaned = "Hello Quill, can you generate a list?";
    expect(resolveCleanedDictation(SPOKEN, cleaned, undefined)).toEqual({
      text: cleaned,
      rejected: null,
    });
  });

  test("a much shorter rewrite is the model's call, not a rejection", () => {
    // The prompt asks for fillers and vague phrasing to go, so a concise
    // rewrite of a rambling utterance is a correct cleanup.
    const spoken =
      "um you know I just kind of wanted to say like thank you so much you know";
    expect(
      resolveCleanedDictation(spoken, "Thank you so much.", "end_turn"),
    ).toEqual({ text: "Thank you so much.", rejected: null });
  });

  test("an empty rewrite falls back to raw without flagging a rejection", () => {
    // The model returned nothing usable; there is no rewrite to distrust.
    expect(resolveCleanedDictation(SPOKEN, "   ", "end_turn")).toEqual({
      text: SPOKEN,
      rejected: null,
    });
  });
});

describe("computeMaxTokens", () => {
  test("budgets room for the transcript, reasoning, and JSON scaffolding", () => {
    // The tool call carries the whole transcript back in `text`, so the
    // budget has to clear the input's own token count with room to spare.
    const estimatedInputTokens = Math.ceil(SPOKEN.length / 3);
    expect(computeMaxTokens(SPOKEN.length)).toBeGreaterThan(
      estimatedInputTokens * 2,
    );
  });

  test("holds a floor for very short transcripts", () => {
    expect(computeMaxTokens(5)).toBe(512);
  });
});
