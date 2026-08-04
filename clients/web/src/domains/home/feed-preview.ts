/**
 * Preview text resolution for home feed cards. A feed item's `summary` is
 * markdown, so it has to be flattened to a single line before it can sit under
 * the title, and suppressed entirely when it would only restate that title.
 */

/** Shortest continuation worth showing after the title's prefix is removed. */
const MIN_PREVIEW_LENGTH = 12;

/** Opening or closing fence of a code block, allowing up to 3 leading spaces. */
const CODE_FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

/** ATX heading, blockquote, or list bullet at the start of a line. */
const BLOCK_MARKER_PATTERN = /^ {0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/;

/** A GFM table delimiter row, plus thematic breaks and blank lines. */
const STRUCTURAL_ROW_PATTERN = /^[\s|:-]*$/;

/**
 * Inline emphasis punctuation ignored when comparing a preview to a title.
 * The set and the pattern share one source so the comparison and the
 * character walk that maps back into the original string cannot drift.
 */
const EMPHASIS_PUNCTUATION = "*_`";
const EMPHASIS_PUNCTUATION_PATTERN = new RegExp(
  `[${EMPHASIS_PUNCTUATION}]`,
  "g",
);

/** Sentence punctuation left dangling once a title prefix is sliced away. */
const SENTENCE_PUNCTUATION = ".,;:-";

/** Sentence punctuation ignored at the end of a comparison. */
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?-]+$/;

/**
 * Turn multi-line markdown into a single line, dropping block syntax while
 * keeping inline emphasis (`**bold**`, `*em*`, backtick code, links) so the
 * result can be rendered as inline markdown.
 *
 * This is the web-side counterpart to the deblocking in
 * `assistant/src/util/short-title.ts`. Web cannot import daemon code, so the
 * two are kept in step by hand.
 */
function flattenMarkdownBlocks(summary: string): string {
  const lines = summary.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  let openFence: string | null = null;

  for (const line of lines) {
    const fence = CODE_FENCE_PATTERN.exec(line)?.[1];
    if (openFence !== null) {
      if (
        fence !== undefined &&
        fence[0] === openFence[0] &&
        fence.length >= openFence.length
      ) {
        openFence = null;
      }
      continue;
    }
    if (fence !== undefined) {
      openFence = fence;
      continue;
    }
    const stripped = stripBlockMarkers(line);
    if (STRUCTURAL_ROW_PATTERN.test(stripped)) {
      continue;
    }
    kept.push(stripped);
  }

  return kept.join(" ").replace(/\s+/g, " ").trim();
}

/** Peel leading block markers off a line, including nested ones like `> - x`. */
function stripBlockMarkers(line: string): string {
  let result = line;
  let previous = "";
  while (result !== previous) {
    previous = result;
    result = result.replace(BLOCK_MARKER_PATTERN, "");
  }
  return result;
}

/**
 * Reduce a string to the form used for title-versus-preview comparison, so
 * that emphasis, spacing, and a trailing period never make two equivalent
 * strings look different.
 */
function normalizeForCompare(value: string): string {
  return value
    .toLowerCase()
    .replace(EMPHASIS_PUNCTUATION_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(TRAILING_PUNCTUATION_PATTERN, "")
    .trim();
}

/**
 * Drop the first `normalizedLength` normalized characters from `original` and
 * return what is left of the untouched string.
 *
 * Normalization changes length, so the offset cannot be reused directly. The
 * two strings are walked in parallel instead: every original character is
 * consumed in turn, and the normalized counter only advances for characters
 * that survive normalization.
 */
function sliceAfterNormalizedPrefix(
  original: string,
  normalizedLength: number,
): string {
  let consumed = 0;
  let index = 0;
  let previousWasSpace = false;

  while (index < original.length && consumed < normalizedLength) {
    const char = original[index];
    index += 1;
    if (EMPHASIS_PUNCTUATION.includes(char)) {
      continue;
    }
    if (/\s/.test(char)) {
      // Runs of whitespace collapse to one space, and leading whitespace is
      // trimmed away entirely, so neither advances the normalized counter.
      if (previousWasSpace || consumed === 0) {
        continue;
      }
      previousWasSpace = true;
    } else {
      previousWasSpace = false;
    }
    consumed += 1;
  }

  return original.slice(index);
}

/**
 * Clean up the join between a sliced-off title and the text that follows it:
 * leading whitespace, sentence punctuation, and any emphasis markers left
 * closing a run whose opener went with the title. Emphasis is only debris
 * while it abuts the cut, so a backtick after a space (the start of a real
 * inline code span) is kept.
 */
function stripSliceDebris(value: string): string {
  let index = 0;
  let sawWhitespace = false;
  while (index < value.length) {
    const char = value[index];
    const isWhitespace = /\s/.test(char);
    const isClosingEmphasis =
      !sawWhitespace && EMPHASIS_PUNCTUATION.includes(char);
    if (
      !isWhitespace &&
      !isClosingEmphasis &&
      !SENTENCE_PUNCTUATION.includes(char)
    ) {
      break;
    }
    sawWhitespace = sawWhitespace || isWhitespace;
    index += 1;
  }
  return value.slice(index);
}

/**
 * True when `value` opens with `prefix` and that prefix ends on a word
 * boundary, so a title of "Deploy" is not read as a prefix of "Deployment
 * queue is backed up".
 */
function startsWithWholeWords(value: string, prefix: string): boolean {
  if (!value.startsWith(prefix)) {
    return false;
  }
  const next = value[prefix.length];
  return next === undefined || !/[\p{L}\p{N}]/u.test(next);
}

/**
 * The preview line for a feed card, or `null` when there is nothing worth
 * showing beneath the title.
 *
 * Returns `null` when the flattened summary is empty, when it matches the
 * title, and when the title is a prefix of it (a title derived from the
 * summary) with too short a continuation left over.
 */
export function resolvePreview(title: string, summary: string): string | null {
  const preview = flattenMarkdownBlocks(summary);
  if (preview.length === 0) {
    return null;
  }

  const normalizedPreview = normalizeForCompare(preview);
  const normalizedTitle = normalizeForCompare(title);
  if (normalizedPreview === normalizedTitle) {
    return null;
  }
  if (!startsWithWholeWords(normalizedPreview, normalizedTitle)) {
    return preview;
  }

  const remainder = stripSliceDebris(
    sliceAfterNormalizedPrefix(preview, normalizedTitle.length),
  );
  return remainder.length < MIN_PREVIEW_LENGTH ? null : remainder;
}
