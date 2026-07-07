/**
 * Speakable-segment extraction for streaming TTS.
 *
 * Splits an incrementally-growing text buffer into complete, speakable
 * segments (sentences or newline-bounded lines) plus a remainder to keep
 * buffering. Callers feed LLM deltas in and synthesize each returned segment
 * as soon as it is complete, so speech starts before the full response lands.
 */

const DEFAULT_CHAR_THRESHOLD = 180;
const EAGER_CHAR_THRESHOLD = 60;

const SENTENCE_ENDING_PUNCTUATION = new Set([".", "!", "?"]);
const TRAILING_SENTENCE_PUNCTUATION = new Set(['"', "'", ")", "]"]);
const EAGER_CLAUSE_PUNCTUATION = new Set([",", ";", ":"]);
// A clause boundary only counts in eager mode once this much text precedes
// it — "Sure, " alone would be a one-word blip.
const EAGER_MIN_CLAUSE_PREFIX_CHARS = 24;

export interface ExtractSpeakableSegmentsOptions {
  /**
   * Trade segment quality for onset latency: clause punctuation (`,` `;` `:`)
   * followed by whitespace also ends a segment once at least
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
    if (char === "\n") {
      return index + 1;
    }

    const inOpenSpan = inBacktick || inBold || inItalic || inUnderscore;

    if (
      !inOpenSpan &&
      eager &&
      EAGER_CLAUSE_PUNCTUATION.has(char) &&
      index >= EAGER_MIN_CLAUSE_PREFIX_CHARS &&
      isWhitespace(text[index + 1] ?? "")
    ) {
      return index + 1;
    }

    if (!inOpenSpan && SENTENCE_ENDING_PUNCTUATION.has(char)) {
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

    if (skipSpanChar) {
      skipSpanChar = false;
    } else if (char === "`") {
      inBacktick = !inBacktick;
    } else if (char === "*") {
      const prev = text[index - 1];
      const next = text[index + 1];
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
      const prev = text[index - 1];
      const next = text[index + 1];
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
  // open span — unbalanced markers there are an accepted edge.
  const preferredBoundary = findLastWhitespaceBoundary(text, charThreshold);
  return preferredBoundary ?? charThreshold;
}

function isWordChar(value: string | undefined): boolean {
  return value !== undefined && /\w/.test(value);
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
