import { describe, expect, test } from "bun:test";

import {
  couldBePlaceholderSentinelPrefix,
  isPlaceholderSentinelText,
  PLACEHOLDER_BLOCKS_OMITTED,
  PLACEHOLDER_EMPTY_TURN,
} from "../placeholder-sentinels.js";

// Bare (null-byte-less) forms, derived from the exported constants so the
// fixtures stay in sync with the source of truth.
const BARE_EMPTY = PLACEHOLDER_EMPTY_TURN.slice(1);
const BARE_BLOCKS = PLACEHOLDER_BLOCKS_OMITTED.slice(1);

describe("isPlaceholderSentinelText", () => {
  test("matches the canonical null-byte-prefixed forms", () => {
    expect(isPlaceholderSentinelText(PLACEHOLDER_EMPTY_TURN)).toBe(true);
    expect(isPlaceholderSentinelText(PLACEHOLDER_BLOCKS_OMITTED)).toBe(true);
  });

  test("matches the bare (prefix-stripped) forms", () => {
    expect(isPlaceholderSentinelText(BARE_EMPTY)).toBe(true);
    expect(isPlaceholderSentinelText(BARE_BLOCKS)).toBe(true);
  });

  test("matches an echo whose null-byte guard arrived as a leading space", () => {
    // The leak observed in production: an Anthropic-compatible proxy replaces
    // the guard byte with a space before echoing the marker back.
    expect(isPlaceholderSentinelText(` ${BARE_EMPTY}`)).toBe(true);
    expect(isPlaceholderSentinelText(` ${BARE_BLOCKS}`)).toBe(true);
  });

  test("tolerates other surrounding whitespace", () => {
    expect(isPlaceholderSentinelText(`${BARE_EMPTY}\n`)).toBe(true);
    expect(isPlaceholderSentinelText(`\t${BARE_EMPTY}  `)).toBe(true);
    expect(isPlaceholderSentinelText(`  ${PLACEHOLDER_EMPTY_TURN}  `)).toBe(
      true,
    );
  });

  test("does not match text that merely contains a sentinel", () => {
    expect(isPlaceholderSentinelText(`discussing ${BARE_EMPTY} here`)).toBe(
      false,
    );
    expect(isPlaceholderSentinelText(`${BARE_EMPTY} trailing words`)).toBe(
      false,
    );
  });

  test("does not match empty, whitespace-only, or unrelated text", () => {
    expect(isPlaceholderSentinelText("")).toBe(false);
    expect(isPlaceholderSentinelText("   ")).toBe(false);
    expect(isPlaceholderSentinelText("hello there")).toBe(false);
    expect(isPlaceholderSentinelText("__PLACEHOLDER__")).toBe(false);
  });
});

describe("couldBePlaceholderSentinelPrefix", () => {
  test("holds a buffer that could still grow into a sentinel", () => {
    expect(couldBePlaceholderSentinelPrefix("_")).toBe(true);
    expect(couldBePlaceholderSentinelPrefix("__PLACEHOLD")).toBe(true);
    expect(couldBePlaceholderSentinelPrefix(BARE_EMPTY)).toBe(true);
  });

  test("holds the leading-space-corrupted prefix the proxy streams", () => {
    // The streamed echo starts with a space, so an untrimmed prefix check would
    // release it onto the live UI; the normalized check holds it.
    expect(couldBePlaceholderSentinelPrefix(" ")).toBe(true);
    expect(couldBePlaceholderSentinelPrefix(" __PLACE")).toBe(true);
    expect(couldBePlaceholderSentinelPrefix(` ${BARE_EMPTY}`)).toBe(true);
    expect(couldBePlaceholderSentinelPrefix(`\x00__PLACE`)).toBe(true);
  });

  test("holds a complete sentinel carrying trailing edge whitespace", () => {
    // A lone delta can carry the whole sentinel plus trailing noise; trimming
    // only the leading edge would overshoot the bare form and flash it.
    expect(couldBePlaceholderSentinelPrefix(`${BARE_EMPTY}\n`)).toBe(true);
    expect(couldBePlaceholderSentinelPrefix(` ${BARE_EMPTY}\n`)).toBe(true);
    expect(couldBePlaceholderSentinelPrefix(`\t${BARE_EMPTY}  `)).toBe(true);
    expect(couldBePlaceholderSentinelPrefix(`${BARE_BLOCKS}\n`)).toBe(true);
  });

  test("releases text that cannot become a sentinel", () => {
    expect(couldBePlaceholderSentinelPrefix(" hello")).toBe(false);
    expect(couldBePlaceholderSentinelPrefix("hello")).toBe(false);
    // Overshoots the sentinel — no longer a prefix.
    expect(couldBePlaceholderSentinelPrefix(`${BARE_EMPTY} x`)).toBe(false);
  });
});

// Mirrors the Anthropic client's `stream.on("text")` buffering loop and its
// `content_block_stop` flush (assistant/src/providers/anthropic/client.ts):
// append each delta, hold while the buffer could still be a sentinel, otherwise
// emit the whole buffer; at block stop, drop the residue only if it is a
// sentinel. Returns the ordered list of text deltas the live UI would receive.
function streamTextDeltas(deltas: readonly string[]): string[] {
  const emitted: string[] = [];
  let textBuffer = "";
  for (const delta of deltas) {
    textBuffer += delta;
    if (couldBePlaceholderSentinelPrefix(textBuffer)) {
      continue;
    }
    emitted.push(textBuffer);
    textBuffer = "";
  }
  // content_block_stop: flush residual text buffer unless it is a sentinel.
  if (textBuffer.length > 0 && !isPlaceholderSentinelText(textBuffer)) {
    emitted.push(textBuffer);
  }
  return emitted;
}

describe("Anthropic stream sentinel buffering", () => {
  test("a whitespace-suffixed sentinel in one delta is dropped at block stop, never emitted", () => {
    // The regression: held through streaming, classified as a sentinel at block
    // stop, so nothing reaches the live UI.
    expect(streamTextDeltas([` ${BARE_EMPTY}\n`])).toEqual([]);
    expect(streamTextDeltas([`${BARE_BLOCKS}\n`])).toEqual([]);
  });

  test("a sentinel prefix followed by real text still streams", () => {
    // The prefix is held alone, then real content breaks it and the whole buffer
    // flushes — genuine content is never withheld.
    expect(streamTextDeltas([BARE_EMPTY, " and then real words"])).toEqual([
      `${BARE_EMPTY} and then real words`,
    ]);
    expect(streamTextDeltas(["__PLACE", "HOLD me a table"])).toEqual([
      "__PLACEHOLD me a table",
    ]);
  });

  test("plain content streams delta-by-delta without batching", () => {
    expect(streamTextDeltas(["Hello", " there"])).toEqual(["Hello", " there"]);
  });
});
