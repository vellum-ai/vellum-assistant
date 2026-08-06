/**
 * Speakable-segment extraction for streaming TTS.
 *
 * Splits an incrementally-growing text buffer into complete, speakable
 * segments (sentences or newline-bounded lines) plus a remainder to keep
 * buffering. Callers feed LLM deltas in and synthesize each returned segment
 * as soon as it is complete, so speech starts before the full response lands.
 */

import { isHighSurrogate, isLowSurrogate } from "../util/unicode.js";

const DEFAULT_CHAR_THRESHOLD = 180;
const EAGER_CHAR_THRESHOLD = 60;

// Sentence enders in scripts without inter-word whitespace (CJK, Thai) or
// with their own terminators (Devanagari danda, Arabic-script marks). Unlike
// ASCII `. ! ?`, these are unambiguous: a boundary after one is valid even
// with no following whitespace.
const NON_LATIN_SENTENCE_ENDING_PUNCTUATION = new Set([
  "。", // ideographic full stop
  "！", // fullwidth exclamation mark
  "？", // fullwidth question mark
  "．", // fullwidth full stop (digit-guarded below: also a decimal point)
  "।", // Devanagari danda
  "॥", // Devanagari double danda
  "؟", // Arabic question mark
  "۔", // Arabic full stop
]);
const SENTENCE_ENDING_PUNCTUATION = new Set([
  ".",
  "!",
  "?",
  ...NON_LATIN_SENTENCE_ENDING_PUNCTUATION,
]);
// Unlike the other non-Latin enders, the fullwidth full stop also serves as
// a decimal point in fullwidth numbers (３．１４), so it is not a boundary
// when a digit follows. The ideographic full stop 。 never marks decimals
// and stays unconditional.
const FULLWIDTH_FULL_STOP = "．";
const TRAILING_SENTENCE_PUNCTUATION = new Set(['"', "'", ")", "]"]);
// After a non-Latin ender, locale closers (CJK corner brackets, curly
// quotes, guillemets) belong to the sentence they follow, exactly like the
// ASCII closers above; without this, 「こんにちは。」 would orphan 」 into
// the next segment. Superset of the ASCII closers so mixed-script text still
// consumes those too.
const NON_LATIN_TRAILING_SENTENCE_PUNCTUATION = new Set([
  ...TRAILING_SENTENCE_PUNCTUATION,
  "」",
  "』",
  "）",
  "】",
  "〕",
  "〙",
  "〗",
  "〛",
  "》",
  "〉",
  "］",
  "｝",
  "”",
  "’",
  "»",
]);
// Clause punctuation in whitespace-free scripts is likewise a valid eager
// boundary regardless of what follows.
const NON_LATIN_EAGER_CLAUSE_PUNCTUATION = new Set([
  "、", // ideographic comma
  "，", // fullwidth comma
  "；", // fullwidth semicolon
  "،", // Arabic comma
]);
const EAGER_CLAUSE_PUNCTUATION = new Set([
  ",",
  ";",
  ":",
  ...NON_LATIN_EAGER_CLAUSE_PUNCTUATION,
]);
// The fullwidth comma also serves as a thousands separator in fullwidth
// numbers (１，０００円), so it is not a clause boundary inside a number. The
// ideographic comma 、 never appears in numbers and needs no guard.
const FULLWIDTH_COMMA = "，";
// A clause boundary only counts in eager mode once this much text precedes
// it — "Sure, " alone would be a one-word blip.
const EAGER_MIN_CLAUSE_PREFIX_CHARS = 24;

export interface ExtractSpeakableSegmentsOptions {
  /**
   * Trade segment quality for onset latency: clause punctuation (`,` `;` `:`
   * followed by whitespace, or a non-Latin clause mark like `、` `，` `،`
   * regardless of what follows) also ends a segment once at least
   * ~24 chars precede it, and the max buffered length before a forced split
   * drops from 180 to 60 chars. Applies only until the
   * first segment of the call is found — later segments keep full-sentence
   * rules. The caller decides when to stop passing `eager` (typically after
   * the first segment is enqueued).
   */
  eager?: boolean;
}

export function extractSpeakableSegments(
  text: string,
  force: boolean,
  options?: ExtractSpeakableSegmentsOptions,
): { segments: string[]; remainder: string } {
  let eager = options?.eager ?? false;
  const segments: string[] = [];
  let remainder = text;

  while (remainder.length > 0) {
    const charThreshold = eager ? EAGER_CHAR_THRESHOLD : DEFAULT_CHAR_THRESHOLD;
    const boundary = findSpeakableBoundary(remainder, charThreshold, eager);
    if (boundary === null) {
      break;
    }

    const segment = remainder.slice(0, boundary).trim();
    if (segment.length > 0) {
      segments.push(segment);
      eager = false;
    }
    remainder = remainder.slice(boundary);
  }

  if (force) {
    const segment = remainder.trim();
    if (segment.length > 0) {
      segments.push(segment);
    }
    remainder = "";
  }

  return { segments, remainder };
}

function findSpeakableBoundary(
  text: string,
  charThreshold: number,
  eager: boolean,
): number | null {
  // Inline-span state (backtick / `**` / `*` / `_`), accumulated over the
  // scan. A boundary inside an open span would split the span across
  // segments, and per-segment sanitization would leave an unbalanced marker
  // to be spoken.
  let inBacktick = false;
  let inBold = false;
  let inItalic = false;
  let inUnderscore = false;
  let skipSpanChar = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (!char) {
      continue;
    }
    const inOpenSpan = inBacktick || inBold || inItalic || inUnderscore;

    if (!inOpenSpan && char === "\n") {
      return index + 1;
    }

    if (
      !inOpenSpan &&
      eager &&
      EAGER_CLAUSE_PUNCTUATION.has(char) &&
      index >= EAGER_MIN_CLAUSE_PREFIX_CHARS &&
      (NON_LATIN_EAGER_CLAUSE_PUNCTUATION.has(char) ||
        isWhitespace(text[index + 1] ?? "")) &&
      !isFullwidthGroupingComma(text, index)
    ) {
      return index + 1;
    }

    if (!inOpenSpan && SENTENCE_ENDING_PUNCTUATION.has(char)) {
      const isNonLatinEnder = NON_LATIN_SENTENCE_ENDING_PUNCTUATION.has(char);
      // The fullwidth full stop doubles as a decimal point in fullwidth
      // numbers (３．１４です), so a following digit suppresses the boundary.
      // It also appears inside Latin filename-style tokens (report．pdf):
      // ASCII word chars on both sides mark it as part of the token, not a
      // sentence end. CJK neighbors keep the boundary, since Japanese
      // sentences legitimately end in ． between CJK words.
      const isAmbiguousDecimalPoint =
        char === FULLWIDTH_FULL_STOP &&
        (isDecimalDigit(text[index + 1]) ||
          (isAsciiWordChar(text[index - 1]) &&
            isAsciiWordChar(text[index + 1])));
      if (isNonLatinEnder && !isAmbiguousDecimalPoint) {
        // Non-Latin enders are valid boundaries regardless of what follows;
        // consume adjacent enders (本当！？) so combined punctuation keeps
        // its prosody and never becomes a punctuation-only segment, then
        // consume locale closers so they stay with their sentence.
        let boundary = index + 1;
        while (
          boundary < text.length &&
          (NON_LATIN_SENTENCE_ENDING_PUNCTUATION.has(text[boundary] ?? "") ||
            NON_LATIN_TRAILING_SENTENCE_PUNCTUATION.has(text[boundary] ?? ""))
        ) {
          boundary += 1;
        }
        // A buffer-final ender is ambiguous while streaming: the next delta
        // may open with closers that belong to this sentence (`「こんにちは。`
        // then `」`) or, for ．, with decimal digits (`３．` then `１４です`).
        // Keep buffering; the `force` flush path still emits a buffer-final
        // sentence at end of turn, and the length cap below still bounds the
        // buffer. ASCII enders keep their end-of-text boundary: whitespace
        // scripts do not attach closers across deltas the same way.
        if (boundary < text.length) {
          return boundary;
        }
      }
      if (!isNonLatinEnder) {
        // ASCII enders require following whitespace so decimals (3.14) and
        // file names don't split.
        let boundary = index + 1;
        while (
          boundary < text.length &&
          TRAILING_SENTENCE_PUNCTUATION.has(text[boundary] ?? "")
        ) {
          boundary += 1;
        }
        if (boundary === text.length || isWhitespace(text[boundary] ?? "")) {
          return boundary;
        }
      }
    }

    if (skipSpanChar) {
      skipSpanChar = false;
    } else if (char === "`") {
      inBacktick = !inBacktick;
    } else if (char === "*") {
      const prev = codePointBefore(text, index);
      const next = codePointAfter(text, index);
      if (next === "*") {
        inBold = !inBold;
        skipSpanChar = true;
      } else if (inItalic) {
        // Mirrors the TTS sanitizer's word-boundary-aware italic rule: a
        // closer needs non-whitespace before it and no word char after, so
        // arithmetic like `5 * 3` and bullet markers never toggle parity.
        if (prev !== undefined && !isWhitespace(prev) && !isWordChar(next)) {
          inItalic = false;
        }
      } else if (
        !isWordChar(prev) &&
        next !== undefined &&
        !isWhitespace(next)
      ) {
        inItalic = true;
      }
    } else if (char === "_") {
      // Same word-boundary rule as `*`. Since `_` neighbors in identifiers
      // like `my_var` are word chars, they never open or close a span.
      const prev = codePointBefore(text, index);
      const next = codePointAfter(text, index);
      if (inUnderscore) {
        if (prev !== undefined && !isWhitespace(prev) && !isWordChar(next)) {
          inUnderscore = false;
        }
      } else if (
        !isWordChar(prev) &&
        next !== undefined &&
        !isWhitespace(next)
      ) {
        inUnderscore = true;
      }
    }
  }

  if (text.length < charThreshold) {
    return null;
  }

  // Length-threshold splits are a hard cap and must flush even inside an
  // open span: unbalanced markers there are an accepted edge.
  const preferredBoundary = findLastWhitespaceBoundary(text, charThreshold);
  if (preferredBoundary !== null) {
    return preferredBoundary;
  }
  // Never split a UTF-16 surrogate pair: if the cap lands mid-pair, step
  // back one unit so both halves stay in the same segment.
  if (isHighSurrogate(text.charCodeAt(charThreshold - 1))) {
    return charThreshold - 1;
  }
  return charThreshold;
}

/**
 * Accepts a full code point (one or two UTF-16 units) so non-BMP letters
 * like 𠮟 count as word chars, matching the sanitizer's Unicode lookarounds
 * in calls/tts-text-sanitizer.ts.
 */
function isWordChar(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}

function isDecimalDigit(value: string | undefined): boolean {
  return value !== undefined && /[0-9０-９]/.test(value);
}

// ASCII-only on purpose: filename-style tokens (report．pdf) are Latin
// script, while CJK neighbors around ． mark real sentence text.
function isAsciiWordChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/.test(value);
}

/**
 * A fullwidth comma acting as a thousands separator (１，０００円): a digit
 * precedes it and a digit follows, or the buffer ends right after it while
 * streaming (the digits may arrive in the next delta, so keep buffering).
 */
function isFullwidthGroupingComma(text: string, index: number): boolean {
  if (text[index] !== FULLWIDTH_COMMA || !isDecimalDigit(text[index - 1])) {
    return false;
  }
  const next = text[index + 1];
  return next === undefined || isDecimalDigit(next);
}

/**
 * The full code point ending just before `index`. When the preceding unit is
 * a low surrogate, includes its high surrogate so `isWordChar` sees the
 * whole character instead of half a pair.
 */
function codePointBefore(text: string, index: number): string | undefined {
  const unit = text[index - 1];
  if (unit === undefined) {
    return undefined;
  }
  if (isLowSurrogate(unit.charCodeAt(0))) {
    const high = text[index - 2];
    if (high !== undefined && isHighSurrogate(high.charCodeAt(0))) {
      return high + unit;
    }
  }
  return unit;
}

/**
 * The full code point starting just after `index`. When the following unit
 * is a high surrogate, includes its low surrogate.
 */
function codePointAfter(text: string, index: number): string | undefined {
  const unit = text[index + 1];
  if (unit === undefined) {
    return undefined;
  }
  if (isHighSurrogate(unit.charCodeAt(0))) {
    const low = text[index + 2];
    if (low !== undefined && isLowSurrogate(low.charCodeAt(0))) {
      return unit + low;
    }
  }
  return unit;
}

function findLastWhitespaceBoundary(
  text: string,
  maxLength: number,
): number | null {
  for (let index = maxLength; index > Math.floor(maxLength * 0.6); index -= 1) {
    if (isWhitespace(text[index] ?? "")) {
      return index + 1;
    }
  }
  return null;
}

function isWhitespace(value: string): boolean {
  return /\s/.test(value);
}
