/**
 * Speakable-segment extraction for streaming TTS.
 *
 * Splits an incrementally-growing text buffer into complete, speakable
 * segments (sentences or newline-bounded lines) plus a remainder to keep
 * buffering. Callers feed LLM deltas in and synthesize each returned segment
 * as soon as it is complete, so speech starts before the full response lands.
 */

export const DEFAULT_SPEAKABLE_SEGMENT_CHAR_THRESHOLD = 180;

const SENTENCE_ENDING_PUNCTUATION = new Set([".", "!", "?"]);
const TRAILING_SENTENCE_PUNCTUATION = new Set(['"', "'", ")", "]"]);

export interface ExtractSpeakableSegmentsOptions {
  /**
   * Max characters buffered before a segment is force-split at the last
   * whitespace boundary. Defaults to
   * {@link DEFAULT_SPEAKABLE_SEGMENT_CHAR_THRESHOLD}.
   */
  charThreshold?: number;
}

export function extractSpeakableSegments(
  text: string,
  force: boolean,
  options?: ExtractSpeakableSegmentsOptions,
): { segments: string[]; remainder: string } {
  const charThreshold =
    options?.charThreshold ?? DEFAULT_SPEAKABLE_SEGMENT_CHAR_THRESHOLD;
  const segments: string[] = [];
  let remainder = text;

  while (remainder.length > 0) {
    const boundary = findSpeakableBoundary(remainder, charThreshold);
    if (boundary === null) break;

    const segment = remainder.slice(0, boundary).trim();
    if (segment.length > 0) {
      segments.push(segment);
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
): number | null {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") return index + 1;
    if (!char || !SENTENCE_ENDING_PUNCTUATION.has(char)) continue;

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
