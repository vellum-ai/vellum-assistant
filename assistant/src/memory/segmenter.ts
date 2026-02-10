import { estimateTextTokens } from '../context/token-estimator.js';

const CHARS_PER_TOKEN_APPROX = 4;
const MIN_SEGMENT_CHARS = 256;

export interface SegmentedText {
  segmentIndex: number;
  text: string;
  tokenEstimate: number;
}

export function segmentText(
  text: string,
  targetTokens: number,
  overlapTokens: number,
): SegmentedText[] {
  const normalized = normalizeInput(text);
  if (normalized.length === 0) return [];

  const maxChars = Math.max(MIN_SEGMENT_CHARS, targetTokens * CHARS_PER_TOKEN_APPROX);
  const overlapChars = Math.min(Math.max(0, overlapTokens * CHARS_PER_TOKEN_APPROX), Math.floor(maxChars / 2));

  if (normalized.length <= maxChars) {
    return [{
      segmentIndex: 0,
      text: normalized,
      tokenEstimate: estimateTextTokens(normalized),
    }];
  }

  const segments: SegmentedText[] = [];
  let start = 0;
  let index = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + maxChars);

    if (end < normalized.length) {
      // Prefer cutting on a whitespace boundary to avoid splitting words.
      const boundary = normalized.lastIndexOf(' ', end);
      if (boundary > start + Math.floor(maxChars * 0.6)) {
        end = boundary;
      }
    }

    const chunk = normalized.slice(start, end).trim();
    if (chunk.length > 0) {
      segments.push({
        segmentIndex: index,
        text: chunk,
        tokenEstimate: estimateTextTokens(chunk),
      });
      index += 1;
    }

    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }

  return segments;
}

function normalizeInput(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[ ]{2,}/g, ' ')
    .trim();
}
