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
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") {
      return index + 1;
    }
    if (!char) {
      continue;
    }

    if (
      eager &&
      EAGER_CLAUSE_PUNCTUATION.has(char) &&
      index >= EAGER_MIN_CLAUSE_PREFIX_CHARS &&
      isWhitespace(text[index + 1] ?? "") &&
      !hasOpenInlineSpan(text.slice(0, index))
    ) {
      return index + 1;
    }

    if (!SENTENCE_ENDING_PUNCTUATION.has(char)) {
      continue;
    }

    let boundary = index + 1;
    while (
      boundary < text.length &&
      TRAILING_SENTENCE_PUNCTUATION.has(text[boundary] ?? "")
    ) {
      boundary += 1;
    }

    if (
      (boundary === text.length || isWhitespace(text[boundary] ?? "")) &&
      !hasOpenInlineSpan(text.slice(0, index))
    ) {
      return boundary;
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

/**
 * Whether the text ends inside an open `**`, `*`, or backtick span. A
 * boundary there would split the span across segments, and per-segment
 * sanitization would leave an unbalanced marker to be spoken.
 */
function hasOpenInlineSpan(prefix: string): boolean {
  let backticks = 0;
  let bold = 0;
  let italic = 0;
  for (let index = 0; index < prefix.length; index += 1) {
    const char = prefix[index];
    if (char === "`") {
      backticks += 1;
    } else if (char === "*") {
      if (prefix[index + 1] === "*") {
        bold += 1;
        index += 1;
      } else {
        italic += 1;
      }
    }
  }
  return backticks % 2 === 1 || bold % 2 === 1 || italic % 2 === 1;
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
