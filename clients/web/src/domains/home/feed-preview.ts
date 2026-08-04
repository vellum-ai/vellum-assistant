/**
 * Preview text resolution for home feed cards. A feed item's `summary` is
 * markdown, so it has to be flattened to a single line before it can sit under
 * the title, and suppressed entirely when it would only restate that title.
 */

/** Shortest continuation worth showing after the title's prefix is removed. */
const MIN_PREVIEW_LENGTH = 12;

/**
 * Opening fence of a code block, allowing up to 3 leading spaces. The second
 * group is the info string, which decides whether a backtick run really opens
 * a block (see `matchFenceOpen`).
 */
const CODE_FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Closing fence of a code block. Nothing but whitespace may follow the fence
 * run, so a line that carries trailing text is code rather than a close.
 */
const CODE_FENCE_CLOSE_PATTERN = /^ {0,3}(`{3,}|~{3,})\s*$/;

/** ATX heading, blockquote, or list bullet at the start of a line. */
const BLOCK_MARKER_PATTERN = /^ {0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/;

/** A GFM table delimiter row, plus thematic breaks and blank lines. */
const STRUCTURAL_ROW_PATTERN = /^[\s|:-]*$/;

/**
 * Inline punctuation ignored when comparing a preview to a title: emphasis,
 * code span, and strikethrough markers.
 */
const INLINE_MARK_PUNCTUATION = "*_`~";

/**
 * Sentence punctuation, ignored at the end of a comparison form and left
 * dangling once a title prefix is sliced away. Both sites read this one set,
 * so the slice can never strand a character the comparison already discounted.
 */
const SENTENCE_PUNCTUATION = ".,;:!?-";

function isSentencePunctuation(char: string): boolean {
  return SENTENCE_PUNCTUATION.includes(char);
}

function trimTrailingSentencePunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && isSentencePunctuation(value[end - 1])) {
    end -= 1;
  }
  return value.slice(0, end);
}

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
    // Container markers come off first so a fence nested in a blockquote or a
    // list item is recognized the same way a top-level one is.
    const stripped = stripBlockMarkers(line);
    if (openFence !== null) {
      const close = CODE_FENCE_CLOSE_PATTERN.exec(stripped)?.[1];
      if (
        close !== undefined &&
        close[0] === openFence[0] &&
        close.length >= openFence.length
      ) {
        openFence = null;
      }
      // A block that never closes swallows the rest of the summary.
      continue;
    }
    const opener = matchFenceOpen(stripped);
    if (opener !== null) {
      openFence = opener;
      continue;
    }
    if (STRUCTURAL_ROW_PATTERN.test(stripped)) {
      continue;
    }
    kept.push(stripped);
  }

  return kept.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * The fence run that opens a code block on `line`, or `null` when the line is
 * ordinary text.
 *
 * A backtick fence's info string may not itself contain a backtick, so a line
 * that opens with a backtick run and carries another one later is prose around
 * an inline code span. Tilde fences carry no such restriction.
 */
function matchFenceOpen(line: string): string | null {
  const match = CODE_FENCE_OPEN_PATTERN.exec(line);
  if (match === null) {
    return null;
  }
  const [, fence, info] = match;
  if (fence.startsWith("`") && info.includes("`")) {
    return null;
  }
  return fence;
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

/** One character of the comparison form and where it ends in the source. */
interface NormalizedCharacter {
  char: string;
  /** Offset in the source string just past the text this character came from. */
  end: number;
}

/** Text range of an inline link and the end of the whole `[text](url)` run. */
interface InlineLinkSpan {
  textStart: number;
  textEnd: number;
  end: number;
}

/**
 * Emit the comparison form of `value` one character at a time, recording where
 * each character ends in the source. Emphasis, code span, and strikethrough
 * punctuation is dropped, a link is reduced to its text, whitespace runs
 * collapse to a single space, and leading whitespace is skipped.
 *
 * Comparison and slicing both read this one walk, so the offset a slice cuts
 * at can never drift from what the comparison removed. Every character of a
 * link's text reports the end of the whole link, which keeps a cut inside that
 * text from stranding the destination in the output.
 */
function normalizedCharacters(value: string): NormalizedCharacter[] {
  const characters: NormalizedCharacter[] = [];
  let index = 0;
  let previousWasSpace = false;
  let linkTextEnd = -1;
  let linkEnd = -1;

  while (index < value.length) {
    if (index === linkTextEnd) {
      index = linkEnd;
      linkTextEnd = -1;
      linkEnd = -1;
      continue;
    }
    if (linkEnd === -1) {
      const link = matchInlineLink(value, index);
      if (link !== null) {
        linkTextEnd = link.textEnd;
        linkEnd = link.end;
        index = link.textStart;
        continue;
      }
    }

    const char = value[index];
    index += 1;
    if (INLINE_MARK_PUNCTUATION.includes(char)) {
      continue;
    }
    const end = linkEnd === -1 ? index : linkEnd;
    if (/\s/.test(char)) {
      if (previousWasSpace || characters.length === 0) {
        continue;
      }
      previousWasSpace = true;
      characters.push({ char: " ", end });
      continue;
    }
    previousWasSpace = false;
    // A case fold that changes length would break the one-to-one mapping.
    const lowered = char.toLowerCase();
    characters.push({ char: lowered.length === 1 ? lowered : char, end });
  }

  return characters;
}

/**
 * Match an inline link `[text](destination)` at `start`, or return `null` when
 * the brackets never close into one.
 */
function matchInlineLink(value: string, start: number): InlineLinkSpan | null {
  if (value[start] !== "[") {
    return null;
  }

  let bracketDepth = 0;
  let textEnd = -1;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (char === "[") {
      bracketDepth += 1;
    } else if (char === "]") {
      bracketDepth -= 1;
      if (bracketDepth === 0) {
        textEnd = index;
        break;
      }
    }
  }
  if (textEnd === -1 || value[textEnd + 1] !== "(") {
    return null;
  }

  let parenDepth = 0;
  for (let index = textEnd + 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") {
      parenDepth += 1;
    } else if (char === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        return { textStart: start + 1, textEnd, end: index + 1 };
      }
    }
  }
  return null;
}

/**
 * Reduce a string to the form used for title-versus-preview comparison, so
 * that inline markup, spacing, and a trailing period never make two equivalent
 * strings look different.
 */
function normalizeForCompare(value: string): string {
  const flattened = normalizedCharacters(value)
    .map((entry) => entry.char)
    .join("")
    .trimEnd();
  return trimTrailingSentencePunctuation(flattened).trimEnd();
}

/**
 * Drop the first `normalizedLength` comparison characters from `original` and
 * return what is left of the untouched string.
 *
 * Normalization changes length, so the offset cannot be reused directly. The
 * walk that produced those characters recorded where each one ends, and the
 * cut is taken from that record.
 */
function sliceAfterNormalizedPrefix(
  original: string,
  normalizedLength: number,
): string {
  if (normalizedLength <= 0) {
    return original;
  }
  const characters = normalizedCharacters(original);
  if (normalizedLength > characters.length) {
    return "";
  }
  return original.slice(characters[normalizedLength - 1].end);
}

/**
 * Clean up the join between a sliced-off title and the text that follows it:
 * leading whitespace, sentence punctuation, and any inline markers left
 * closing a run whose opener went with the title. A marker is only debris
 * while it abuts the cut, so a backtick after a space (the start of a real
 * inline code span) is kept.
 */
function stripSliceDebris(value: string): string {
  let index = 0;
  let sawWhitespace = false;
  while (index < value.length) {
    const char = value[index];
    const isWhitespace = /\s/.test(char);
    const isClosingMark =
      !sawWhitespace && INLINE_MARK_PUNCTUATION.includes(char);
    if (!isWhitespace && !isClosingMark && !isSentencePunctuation(char)) {
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
