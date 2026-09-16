/**
 * Splits a markdown document into top-level blocks so a document that grows
 * by appends (a streamed reply, a reasoning trace) can be parsed and rendered
 * one block at a time, with every block but the last reused verbatim as the
 * tail grows.
 *
 * A cut is made at a blank line that sits outside any fence (a ``` / ~~~ code
 * fence or a $$ math fence) and is followed by a line starting at column 0.
 * An indented follow-on line stays with its block, since it continues a list
 * item or an indented code block, and a list item that follows a list keeps
 * the loose list whole. A block therefore never splits a construct that a
 * blank line does not already end, so each block parses on its own to the
 * same tree it would inside the whole document. The exceptions are the
 * document-wide references CommonMark resolves after parsing (link reference
 * definitions, GFM footnotes), which resolve only within the block that
 * defines them, and the few raw HTML blocks that run past a blank line
 * (`<pre>`, `<script>`, comments), which end at the blank line instead.
 *
 * Every block carries its own trailing blank lines, so the blocks always
 * concatenate back to the exact source: `blocks.join("") === content`.
 */

export interface MarkdownBlockSplit {
  /** The source the blocks were cut from. */
  readonly content: string;
  /**
   * The blocks in document order. Empty for empty content; otherwise the last
   * block is the open tail that the next append lands in.
   */
  readonly blocks: readonly string[];
}

const CODE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
// remark-math's flow construct: a run of two or more dollars, optional meta
// that may not contain another dollar, and a closing run at least as long.
const MATH_FENCE_OPEN = /^ {0,3}(\${2,})[^$]*$/;
// Only spaces and tabs count as whitespace to CommonMark, so a closing fence
// or a blank line may carry nothing else (a stray U+00A0 makes a line
// content). Lines reach these patterns without their terminator.
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,}|\${2,})[ \t]*$/;
const BLANK_LINE = /^[ \t]*$/;
const INDENTED_LINE = /^[ \t]/;
// A top-level list item may sit up to three spaces in, and may be empty.
const LIST_MARKER = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;

/**
 * The fence a scanner is inside, if any: the run of characters that opened
 * it. A closing run must use the same character and be at least as long, for
 * code and math fences alike.
 */
interface Fence {
  readonly marker: string;
}

function closesFence(line: string, fence: Fence): boolean {
  const match = FENCE_CLOSE.exec(line);
  if (match === null) {
    return false;
  }
  const marker = match[1]!;
  return marker[0] === fence.marker[0] && marker.length >= fence.marker.length;
}

function opensFence(line: string): Fence | null {
  const match = CODE_FENCE_OPEN.exec(line) ?? MATH_FENCE_OPEN.exec(line);
  return match === null ? null : { marker: match[1]! };
}

/** One pass over `text` from a block boundary; see the module docs for the cut rule. */
function scanBlocks(text: string): string[] {
  const blocks: string[] = [];
  let blockStart = 0;
  let blockHasContent = false;
  // Whether the block's current top-level construct is a list. A column-0
  // list marker starts one whether it opens the block or interrupts a
  // paragraph, and only a cut ends it: every line until then is an item,
  // an indented continuation, or a lazy continuation of an item.
  let inList = false;
  let fence: Fence | null = null;
  let afterBlank = false;

  let lineStart = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline + 1;
    // The line as the patterns see it: without its terminator, including the
    // CR that CRLF input leaves. Offsets still slice the original text, so
    // the blocks keep every byte.
    let line = text.slice(lineStart, newline === -1 ? text.length : newline);
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }

    if (fence !== null) {
      if (closesFence(line, fence)) {
        fence = null;
      }
      afterBlank = false;
    } else if (BLANK_LINE.test(line)) {
      afterBlank = true;
    } else {
      const isListItem = LIST_MARKER.test(line);
      const startsNewBlock =
        afterBlank &&
        blockHasContent &&
        !INDENTED_LINE.test(line) &&
        !(inList && isListItem);
      if (startsNewBlock) {
        blocks.push(text.slice(blockStart, lineStart));
        blockStart = lineStart;
        inList = false;
      }
      afterBlank = false;
      blockHasContent = true;
      if (isListItem) {
        inList = true;
      }
      fence = opensFence(line);
    }

    lineStart = lineEnd;
  }

  if (blockStart < text.length) {
    blocks.push(text.slice(blockStart));
  }
  return blocks;
}

/**
 * Split `content` into top-level markdown blocks.
 *
 * Pass the previous result for the same growing document and only the open
 * tail is rescanned: when `content` extends `previous.content`, every settled
 * block is carried over as the same string, so a renderer keyed on block text
 * can skip all of them. Content that is not an extension (a rewrite, a reset)
 * is scanned in full.
 *
 * Establishing that `content` extends the previous content is a prefix
 * compare over the settled text, which is linear in the document but a plain
 * memcmp: a few microseconds per hundred kilobytes, against the millisecond
 * or more that parsing a block costs. It stays a full compare on purpose. A
 * check on length or on a sample of characters would let a rewritten
 * document of the same shape keep stale settled blocks, and the caller has
 * already paid a linear copy to build the string, so there is no sub-linear
 * floor to reach here.
 */
export function splitMarkdownBlocks(
  content: string,
  previous?: MarkdownBlockSplit,
): MarkdownBlockSplit {
  if (content.length === 0) {
    return { content, blocks: [] };
  }
  if (
    previous !== undefined &&
    previous.blocks.length > 0 &&
    content.startsWith(previous.content)
  ) {
    const settled = previous.blocks.slice(0, -1);
    const tail = previous.blocks[previous.blocks.length - 1]!;
    const tailStart = previous.content.length - tail.length;
    return {
      content,
      blocks: [...settled, ...scanBlocks(content.slice(tailStart))],
    };
  }
  return { content, blocks: scanBlocks(content) };
}
