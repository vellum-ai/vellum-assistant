import { describe, expect, test } from "bun:test";

import {
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
