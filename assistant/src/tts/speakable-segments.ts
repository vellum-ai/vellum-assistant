/**
 * Speakable-segment extraction for streaming TTS.
 *
 * Splits an incrementally-growing text buffer into complete, speakable
 * segments (sentences or newline-bounded lines) plus a remainder to keep
 * buffering. Callers feed LLM deltas in and synthesize each returned segment
 * as soon as it is complete, so speech starts before the full response lands.
 */

export const DEFAULT_SPEAKABLE_SEGMENT_CHAR_THRESHOLD = 180;
export const EAGER_SPEAKABLE_SEGMENT_CHAR_THRESHOLD = 60;

const SENTENCE_ENDING_PUNCTUATION = new Set([".", "!", "?"]);
const TRAILING_SENTENCE_PUNCTUATION = new Set(['"', "'", ")", "]"]);
const EAGER_CLAUSE_PUNCTUATION = new Set([",", ";", ":"]);
// A clause boundary only counts in eager mode once this much text precedes
// it — "Sure, " alone would be a one-word blip.
const EAGER_MIN_CLAUSE_PREFIX_CHARS = 24;

export interface ExtractSpeakableSegmentsOptions {
  /**
   * Max characters buffered before a segment is force-split at the last
   * whitespace boundary. Defaults to
   * {@link DEFAULT_SPEAKABLE_SEGMENT_CHAR_THRESHOLD}
   * ({@link EAGER_SPEAKABLE_SEGMENT_CHAR_THRESHOLD} when `eager`).
   */
  charThreshold?: number;
  /**
   * Trade segment quality for onset latency: clause punctuation (`,` `;` `:`)
   * followed by whitespace also ends a segment once at least
   * ~24 chars precede it, and the default char threshold drops to
   * {@link EAGER_SPEAKABLE_SEGMENT_CHAR_THRESHOLD}. Applies only until the
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
    const charThreshold =
      options?.charThreshold ??
      (eager
        ? EAGER_SPEAKABLE_SEGMENT_CHAR_THRESHOLD
        : DEFAULT_SPEAKABLE_SEGMENT_CHAR_THRESHOLD);
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
      isWhitespace(text[index + 1] ?? "")
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

    if (boundary === text.length || isWhitespace(text[boundary] ?? "")) {
      return boundary;
    }
  }

  if (text.length < charThreshold) {
    return null;
  }

  const preferredBoundary = findLastWhitespaceBoundary(text, charThreshold);
  return preferredBoundary ?? charThreshold;
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
