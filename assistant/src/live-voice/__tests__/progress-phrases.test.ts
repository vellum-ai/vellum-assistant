/**
 * Tests for the static spoken-phrase tables (progress fallbacks and the
 * approval-pending phrase): full coverage of the Deepgram code-switching
 * roster, the per-phrase invariants (persona-neutral floor-holders, word
 * or length budgets, a recognized sentence terminator), and the
 * language-aware selection with its English default.
 */

import { describe, expect, test } from "bun:test";

import { BRIDGE_SENTENCE_END_REGEX } from "../../calls/voice-triage-escalate.js";
import { DEEPGRAM_MULTI_LANGUAGE_CODES } from "../../providers/speech-to-text/deepgram.js";
import {
  APPROVAL_PENDING_PHRASE,
  APPROVAL_PENDING_PHRASE_BY_LANGUAGE,
  approvalPendingPhraseFor,
  pickProgressPhrase,
  PROGRESS_FALLBACK_PHRASES,
  PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE,
} from "../progress-phrases.js";

// Scripts without space-delimited words, where a word budget is
// meaningless and length is asserted instead.
const NON_WORD_COUNTED_LANGUAGES = new Set(["ja"]);

// Every table phrase is spoken audio, so it must end in a terminator the
// speech pipeline recognizes (shared roster from voice-triage-escalate).
function expectEndsInSentenceTerminator(phrase: string): void {
  expect(BRIDGE_SENTENCE_END_REGEX.test(phrase.trim().slice(-1))).toBe(true);
}

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

  test("every phrase ends in a recognized sentence terminator", () => {
    for (const phrases of Object.values(
      PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE,
    )) {
      for (const phrase of phrases) {
        expectEndsInSentenceTerminator(phrase);
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

  test("never resolves prototype keys as phrase tables", () => {
    expect(pickProgressPhrase(0, "constructor")).toBe(
      PROGRESS_FALLBACK_PHRASES[0],
    );
  });
});

describe("APPROVAL_PENDING_PHRASE_BY_LANGUAGE", () => {
  test("covers every Deepgram code-switching language", () => {
    for (const code of DEEPGRAM_MULTI_LANGUAGE_CODES) {
      const phrase = APPROVAL_PENDING_PHRASE_BY_LANGUAGE[code];
      expect(phrase).toBeDefined();
      expect(phrase!.trim().length).toBeGreaterThan(0);
    }
  });

  test("every phrase stays short", () => {
    for (const [code, phrase] of Object.entries(
      APPROVAL_PENDING_PHRASE_BY_LANGUAGE,
    )) {
      if (NON_WORD_COUNTED_LANGUAGES.has(code)) {
        // No spaces to count words by; assert a comparable spoken length.
        expect(phrase.length).toBeLessThanOrEqual(30);
      } else {
        expect(phrase.split(/\s+/).length).toBeLessThanOrEqual(12);
      }
    }
  });

  test("every phrase ends in a recognized sentence terminator", () => {
    for (const phrase of Object.values(APPROVAL_PENDING_PHRASE_BY_LANGUAGE)) {
      expectEndsInSentenceTerminator(phrase);
    }
  });

  test("the en entry is the exported English phrase", () => {
    expect(APPROVAL_PENDING_PHRASE_BY_LANGUAGE.en).toBe(
      APPROVAL_PENDING_PHRASE,
    );
  });
});

describe("approvalPendingPhraseFor", () => {
  test("selects by the language's lowercased base subtag", () => {
    expect(approvalPendingPhraseFor("es")).toBe(
      APPROVAL_PENDING_PHRASE_BY_LANGUAGE.es!,
    );
    expect(approvalPendingPhraseFor("pt-BR")).toBe(
      APPROVAL_PENDING_PHRASE_BY_LANGUAGE.pt!,
    );
  });

  test("falls back to English for unknown, blank, or absent languages", () => {
    expect(approvalPendingPhraseFor("ko")).toBe(APPROVAL_PENDING_PHRASE);
    expect(approvalPendingPhraseFor("")).toBe(APPROVAL_PENDING_PHRASE);
    expect(approvalPendingPhraseFor(undefined)).toBe(APPROVAL_PENDING_PHRASE);
    expect(approvalPendingPhraseFor("constructor")).toBe(
      APPROVAL_PENDING_PHRASE,
    );
  });
});
