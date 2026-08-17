/**
 * Shared primitives for streaming think-tag scanning.
 *
 * Two consumers parse inline `<think>` spans out of streamed model content
 * and must not drift apart (single source of truth):
 *
 * - `providers/openai/chat-completions-provider.ts` ROUTES the spans to
 *   `thinking_delta` events (content preserved, case-sensitive `<think>`
 *   only, matching the models that emit it).
 * - `tts/reasoning-tag-filter.ts` DROPS the spans from the spoken stream
 *   (case-insensitive, `<think>` and `<thinking>` variants).
 *
 * The state machines stay separate because they do different things with
 * the reasoning; what they share is the tag scanning below. All scanning is
 * positionally exact on the ORIGINAL string: case-insensitive mode folds
 * A-Z per character code and never calls `toLowerCase()` on the haystack,
 * because Unicode lowercasing can change string length (e.g. dotted capital
 * I, U+0130, lowers to two code units) and shift every subsequent index.
 * Tags must be given in lowercase ASCII.
 */

function foldedCharCode(code: number, caseInsensitive: boolean): number {
  return caseInsensitive && code >= 65 && code <= 90 ? code + 32 : code;
}

function tagMatchesAt(
  haystack: string,
  start: number,
  tag: string,
  caseInsensitive: boolean,
): boolean {
  if (start + tag.length > haystack.length) {
    return false;
  }
  for (let k = 0; k < tag.length; k += 1) {
    if (
      foldedCharCode(haystack.charCodeAt(start + k), caseInsensitive) !==
      tag.charCodeAt(k)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * First occurrence of any tag in `haystack`, by original-string index.
 * When several tags match at the same index the longest wins, so
 * `<thinking>` is not consumed as `<think>` plus stray text.
 */
export function indexOfTag(
  haystack: string,
  tags: readonly string[],
  caseInsensitive: boolean,
): { index: number; tag: string } | null {
  for (let i = 0; i < haystack.length; i += 1) {
    let bestTag: string | null = null;
    for (const tag of tags) {
      if (tagMatchesAt(haystack, i, tag, caseInsensitive)) {
        if (bestTag === null || tag.length > bestTag.length) {
          bestTag = tag;
        }
      }
    }
    if (bestTag !== null) {
      return { index: i, tag: bestTag };
    }
  }
  return null;
}

/**
 * Length of the longest suffix of `text` that is a proper prefix of any
 * listed tag. Streaming scanners hold that many characters back so a tag
 * split across deltas is not emitted before it can be recognized.
 */
export function partialTagSuffix(
  text: string,
  tags: readonly string[],
  caseInsensitive: boolean,
): number {
  const longest = Math.max(...tags.map((tag) => tag.length)) - 1;
  for (let len = Math.min(text.length, longest); len > 0; len -= 1) {
    const start = text.length - len;
    for (const tag of tags) {
      if (
        len < tag.length &&
        tagMatchesAt(text, start, tag.slice(0, len), caseInsensitive)
      ) {
        return len;
      }
    }
  }
  return 0;
}
