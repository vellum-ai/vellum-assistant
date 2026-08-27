/**
 * The dictation cleanup pass rewrites what the user actually said, so the
 * rewrite only becomes the payload when it is plausibly the same utterance.
 *
 * LUM-3432: a rewrite cut short by a `max_tokens` stop, or one that dropped
 * most of the transcript, used to be inserted verbatim -- the user sent a
 * fragment of a request they had spoken in full, with no indication anything
 * was missing.
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

  test("rejects a summary that dropped most of the transcript", () => {
    expect(
      resolveCleanedDictation(SPOKEN, "Can you create a list?", "end_turn"),
    ).toEqual({ text: SPOKEN, rejected: "too-short" });
  });

  test("short utterances are exempt from the length ratio", () => {
    // Filler removal legitimately guts a short phrase, so the ratio would
    // reject a correct cleanup here.
    expect(
      resolveCleanedDictation("um yeah okay so", "Okay.", "end_turn"),
    ).toEqual({ text: "Okay.", rejected: null });
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
    // The tool call carries the whole transcript back in `text`, so a budget
    // at or near the input's own token count is what let a rewrite get cut
    // mid-argument.
    const estimatedInputTokens = Math.ceil(SPOKEN.length / 3);
    expect(computeMaxTokens(SPOKEN.length)).toBeGreaterThan(
      estimatedInputTokens * 2,
    );
  });

  test("holds a floor for very short transcripts", () => {
    expect(computeMaxTokens(5)).toBe(512);
  });
});
