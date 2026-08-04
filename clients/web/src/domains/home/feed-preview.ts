/**
 * Preview text resolution for home feed cards. A feed item's `summary` is
 * markdown, so it has to be flattened to a single line of plain text before it
 * can sit under the title, and suppressed entirely when it would only restate
 * that title. The returned string carries no markdown syntax and is meant to be
 * rendered directly.
 */

import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/** Shortest continuation worth showing after the title's prefix is removed. */
const MIN_PREVIEW_LENGTH = 12;

/**
 * Sentence punctuation, ignored at the end of a comparison form and left
 * dangling once a title prefix is sliced away. Both sites read this one set,
 * so the slice can never strand a character the comparison already discounted.
 *
 * The horizontal ellipsis is in here so a title the producer truncated compares
 * as its unellipsized text and is still recognized as derived from the summary.
 * The three-period form falls out of `.` already being a member, since the
 * trailing trim runs over the whole punctuation run.
 */
const SENTENCE_PUNCTUATION = ".,;:!?-…";

/**
 * A trailing truncation marker: a horizontal ellipsis or a run of three or more
 * ASCII periods. The producer appends one when it clamps a title at a fixed
 * character offset, which makes the marker its explicit signal that the title
 * was cut in the middle of the text it came from.
 */
const TRUNCATION_MARKER = /(?:…|\.{3,})$/;

/**
 * The parts of a markdown node the flattener reads. Structural rather than
 * imported so the walk stays tolerant of node types remark adds.
 */
interface MarkdownNode {
  type: string;
  value?: string;
  alt?: string | null;
  children?: MarkdownNode[];
}

/**
 * Node types that carry inline content. Inline siblings run together with no
 * separator; every other node is a block and is spaced away from its
 * neighbours.
 */
const INLINE_NODE_TYPES = new Set([
  "break",
  "delete",
  "emphasis",
  "footnoteReference",
  "image",
  "imageReference",
  "inlineCode",
  "link",
  "linkReference",
  "strong",
  "text",
]);

const markdownParser = unified().use(remarkParse).use(remarkGfm);

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
 * Turn multi-line markdown into a single line of plain text, dropping block
 * structure and code blocks and unwrapping every inline marker. A link
 * contributes its text and drops its destination.
 */
function flattenMarkdownBlocks(summary: string): string {
  const tree = markdownParser.parse(summary) as MarkdownNode;
  return flattenNode(tree).replace(/\s+/g, " ").trim();
}

/** The single-line text a node contributes to the preview. */
function flattenNode(node: MarkdownNode): string {
  switch (node.type) {
    case "code":
    case "html":
    case "thematicBreak":
    case "yaml": {
      return "";
    }
    case "inlineCode":
    case "text": {
      return node.value ?? "";
    }
    case "break": {
      return " ";
    }
    case "delete":
    case "emphasis":
    case "link":
    case "linkReference":
    case "strong": {
      return flattenChildren(node);
    }
    case "image":
    case "imageReference": {
      const alt = node.alt ?? "";
      return alt.trim().length === 0 ? "" : alt;
    }
    default: {
      if (node.children !== undefined) {
        return flattenChildren(node);
      }
      return node.value ?? "";
    }
  }
}

/**
 * Concatenate what a node's children contribute, separating each block from
 * the one before it with a single space. Children that contribute nothing,
 * such as a dropped code block, never introduce a separator of their own.
 */
function flattenChildren(node: MarkdownNode): string {
  let result = "";
  for (const child of node.children ?? []) {
    const text = flattenNode(child);
    if (text.length === 0) {
      continue;
    }
    if (result.length > 0 && !INLINE_NODE_TYPES.has(child.type)) {
      result += " ";
    }
    result += text;
  }
  return result;
}

/** One character of the comparison form and where it ends in the source. */
interface NormalizedCharacter {
  char: string;
  /** Offset in the source string just past the text this character came from. */
  end: number;
}

/**
 * Emit the comparison form of `value` one character at a time, recording where
 * each character ends in the source. Whitespace runs collapse to a single
 * space, leading whitespace is skipped, and letters are lowercased.
 *
 * Comparison and slicing both read this one walk, so the offset a slice cuts
 * at can never drift from what the comparison collapsed.
 */
function normalizedCharacters(value: string): NormalizedCharacter[] {
  const characters: NormalizedCharacter[] = [];
  let previousWasSpace = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const end = index + 1;
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
 * Reduce a string to the form used for title-versus-preview comparison, so
 * that case, spacing, and trailing sentence punctuation never make two
 * equivalent strings look different.
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
 * Clean up the join between a sliced-off title and the text that follows it,
 * dropping the leading whitespace and sentence punctuation the cut leaves
 * behind.
 */
function stripSliceDebris(value: string): string {
  let index = 0;
  while (index < value.length) {
    const char = value[index];
    if (!/\s/.test(char) && !isSentencePunctuation(char)) {
      break;
    }
    index += 1;
  }
  return value.slice(index);
}

/**
 * Whether a character belongs to a word. Combining marks count, so a
 * decomposed letter is never split away from its accent.
 */
function isWordCharacter(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{M}\p{N}]/u.test(char);
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
  return !isWordCharacter(value[prefix.length]);
}

/**
 * Walk `index` back to where its word starts in `value`, so a cut taken there
 * opens on a whole word rather than on the tail of one.
 */
function startOfWordAt(value: string, index: number): number {
  let start = index;
  while (start > 0 && isWordCharacter(value[start - 1])) {
    start -= 1;
  }
  return start;
}

/**
 * The preview line for a feed card, or `null` when there is nothing worth
 * showing beneath the title.
 *
 * Returns `null` when the flattened summary is empty, when it matches the
 * title, and when the title is a prefix of it (a title derived from the
 * summary) with too short a continuation left over.
 *
 * A title carrying a trailing truncation marker is exempt from the word
 * boundary check, because a clamp at a fixed offset lands mid-word often and
 * the marker is the producer saying so. Its cut then moves back to the start of
 * the straddled word, which repeats one visibly truncated word rather than
 * dropping the rest of it.
 *
 * The marker has to be read off the untouched title, since normalization
 * discards it along with the rest of the trailing sentence punctuation.
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

  const isTruncated = TRUNCATION_MARKER.test(title.trimEnd());
  const isDerived = isTruncated
    ? normalizedPreview.startsWith(normalizedTitle)
    : startsWithWholeWords(normalizedPreview, normalizedTitle);
  if (!isDerived) {
    return preview;
  }

  const cut =
    isTruncated && isWordCharacter(normalizedPreview[normalizedTitle.length])
      ? startOfWordAt(normalizedPreview, normalizedTitle.length)
      : normalizedTitle.length;

  const remainder = stripSliceDebris(sliceAfterNormalizedPrefix(preview, cut));
  return remainder.length < MIN_PREVIEW_LENGTH ? null : remainder;
}
