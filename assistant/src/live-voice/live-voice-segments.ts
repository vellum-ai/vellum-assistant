/**
 * Speakable-segment extraction for streaming TTS.
 *
 * Incoming assistant text is buffered until a natural speech boundary
 * (sentence-ending punctuation followed by whitespace, or a newline) is
 * found, so TTS synthesis can start before the full message arrives
 * without splitting mid-sentence. Buffers that grow past
 * {@link LIVE_VOICE_TTS_SEGMENT_CHAR_THRESHOLD} without a natural
 * boundary are split conservatively at a trailing whitespace position.
 */

export const LIVE_VOICE_TTS_SEGMENT_CHAR_THRESHOLD = 180;
export const SENTENCE_ENDING_PUNCTUATION = new Set([".", "!", "?"]);
const TRAILING_SENTENCE_PUNCTUATION = new Set(['"', "'", ")", "]"]);

/**
 * Split `text` into speakable segments plus an unconsumed remainder.
 * When `force` is true the remainder is flushed as a final segment.
 */
export function extractSpeakableSegments(
  text: string,
  force: boolean,
): { segments: string[]; remainder: string } {
  const segments: string[] = [];
  let remainder = text;

  while (remainder.length > 0) {
    const boundary = findSpeakableBoundary(remainder);
    if (boundary === null) {
      break;
    }

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

/**
 * Find the first index one past a speakable boundary in `text`, or null
 * when no boundary exists yet and the text is still under the segment
 * threshold.
 */
export function findSpeakableBoundary(text: string): number | null {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") {
      return index + 1;
    }
    if (!char || !SENTENCE_ENDING_PUNCTUATION.has(char)) {
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

  if (text.length < LIVE_VOICE_TTS_SEGMENT_CHAR_THRESHOLD) {
    return null;
  }

  const preferredBoundary = findLastWhitespaceBoundary(
    text,
    LIVE_VOICE_TTS_SEGMENT_CHAR_THRESHOLD,
  );
  return preferredBoundary ?? LIVE_VOICE_TTS_SEGMENT_CHAR_THRESHOLD;
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
