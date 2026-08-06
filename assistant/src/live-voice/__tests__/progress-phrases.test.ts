/**
 * Tests for the static progress-phrase fallback tables: full coverage of the
 * Deepgram code-switching roster, the per-phrase invariants (persona-neutral
 * floor-holders, at most 8 words where word-counting makes sense), and the
 * language-aware selection in `pickProgressPhrase` with its English default.
 */

import { describe, expect, test } from "bun:test";

import { DEEPGRAM_MULTI_LANGUAGE_CODES } from "../../providers/speech-to-text/deepgram.js";
import {
  pickProgressPhrase,
  PROGRESS_FALLBACK_PHRASES,
  PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE,
} from "../progress-phrases.js";

// Scripts without space-delimited words, where an 8-word budget is
// meaningless and length is asserted instead.
const NON_WORD_COUNTED_LANGUAGES = new Set(["ja"]);

describe("PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE", () => {
  test("covers every Deepgram code-switching language with three phrases", () => {
    for (const code of DEEPGRAM_MULTI_LANGUAGE_CODES) {
      const phrases = PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE[code];
      expect(phrases).toBeDefined();
      expect(phrases).toHaveLength(3);
      for (const phrase of phrases!) {
        expect(phrase.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("every phrase stays within the 8-word budget", () => {
    for (const [code, phrases] of Object.entries(
      PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE,
    )) {
      for (const phrase of phrases) {
        if (NON_WORD_COUNTED_LANGUAGES.has(code)) {
          // No spaces to count words by; assert a comparable spoken length.
          expect(phrase.length).toBeLessThanOrEqual(30);
        } else {
          expect(phrase.split(/\s+/).length).toBeLessThanOrEqual(8);
        }
      }
    }
  });

  test("the en entry is the exported English list", () => {
    expect(PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE.en).toBe(
      PROGRESS_FALLBACK_PHRASES,
    );
  });
});

describe("pickProgressPhrase", () => {
  test("with no language returns exactly the English phrases", () => {
    for (let i = 0; i < 6; i++) {
      expect(pickProgressPhrase(i)).toBe(
        PROGRESS_FALLBACK_PHRASES[i % PROGRESS_FALLBACK_PHRASES.length],
      );
    }
  });

  test("selects the table for the language's lowercased base subtag", () => {
    expect(pickProgressPhrase(0, "es")).toBe(
      PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE.es![0],
    );
    expect(pickProgressPhrase(1, "pt-BR")).toBe(
      PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE.pt![1],
    );
    expect(pickProgressPhrase(2, "HI")).toBe(
      PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE.hi![2],
    );
  });

  test("rotates deterministically through the selected table", () => {
    expect(pickProgressPhrase(3, "de")).toBe(pickProgressPhrase(0, "de"));
    expect(pickProgressPhrase(4, "de")).toBe(pickProgressPhrase(1, "de"));
  });

  test("falls back to English for unknown or blank languages", () => {
    expect(pickProgressPhrase(0, "ko")).toBe(PROGRESS_FALLBACK_PHRASES[0]);
    expect(pickProgressPhrase(0, "")).toBe(PROGRESS_FALLBACK_PHRASES[0]);
  });
});
