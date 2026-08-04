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
 */
const SENTENCE_PUNCTUATION = ".,;:!?-";

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
 * that case, spacing, and a trailing period never make two equivalent strings
 * look different.
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
 * True when `value` opens with `prefix` and that prefix ends on a word
 * boundary, so a title of "Deploy" is not read as a prefix of "Deployment
 * queue is backed up".
 *
 * Combining marks count as part of the preceding word, so a decomposed letter
 * straddling the cut ("Cafe" against "Café") is not a boundary.
 */
function startsWithWholeWords(value: string, prefix: string): boolean {
  if (!value.startsWith(prefix)) {
    return false;
  }
  const next = value[prefix.length];
  return next === undefined || !/[\p{L}\p{M}\p{N}]/u.test(next);
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
