/**
 * Discord message rendering: canonical reply markdown into sendable chunks.
 *
 * Discord renders a markdown dialect close to what the agent already writes
 * (bold, italic, strikethrough, inline code, fenced code, blockquotes, lists,
 * links, and headings h1 to h3), so the text passes through unmodified. The
 * work here is splitting: `content` on Create Message is capped, and a reply
 * over the cap is rejected outright rather than truncated.
 *
 * Splitting is fence-aware and line-aware because a naive slice breaks
 * rendering, not just layout. Cutting inside a fenced code block leaves the
 * first chunk with an unterminated fence and the second starting with a stray
 * "```", so Discord renders both as garbage. Chunks therefore break on line
 * boundaries where possible, and an open fence is closed at the end of one
 * chunk and reopened (with its original info string) at the start of the next.
 *
 * https://docs.discord.com/developers/resources/message
 */

/**
 * Discord's cap on the `content` field of a message. Chunks are built to fit
 * inside this so the API never rejects a send for length.
 */
export const DISCORD_MAX_MESSAGE_LENGTH = 2000;

/** A fence line: three or more backticks, optionally indented. */
const FENCE_PATTERN = /^\s*(`{3,})/;

/** A fence line carrying no info string, which can close an open block. */
const BARE_FENCE_PATTERN = /^\s*`{3,}\s*$/;

/**
 * Length of a line's opening backtick run, or 0 when it is not a fence.
 *
 * The run length matters on both ends: a closing fence must be at least as
 * long as the one it closes, so a block opened with four or more backticks is
 * not terminated by a three-backtick line.
 */
function fenceRun(line: string): number {
  return FENCE_PATTERN.exec(line)?.[1].length ?? 0;
}

/** The closing fence for an open block: its own delimiter, no info string. */
function closeFor(openFence: string): string {
  return "`".repeat(fenceRun(openFence));
}

/** Cost of appending a block's closing fence to a chunk: the line plus its newline. */
function closeCostFor(openFence: string | undefined): number {
  return openFence === undefined ? 0 : fenceRun(openFence) + 1;
}

/**
 * The open-fence state after `line` is appended, given the state before it.
 * `undefined` means no code block is open; otherwise it is the opening fence
 * line verbatim, so a split can reopen the block with its original delimiter
 * and info string.
 */
function fenceStateAfter(
  line: string,
  openFence: string | undefined,
): string | undefined {
  const run = fenceRun(line);
  if (run === 0) {
    return openFence;
  }
  if (openFence === undefined) {
    return line;
  }
  // A fence closes the block only when it carries no info string and its run
  // is at least as long as the opener. Anything else is content inside it,
  // which is the whole point of opening with a longer run.
  return BARE_FENCE_PATTERN.test(line) && run >= fenceRun(openFence)
    ? undefined
    : openFence;
}

/**
 * Split a reply into Discord-sized chunks, preserving fenced code blocks
 * across the boundaries.
 *
 * Returns an empty array for blank input so callers can skip the send
 * entirely rather than posting an empty message, which Discord rejects.
 */
export function renderDiscordMessages(
  text: string,
  maxLength: number = DISCORD_MAX_MESSAGE_LENGTH,
): string[] {
  if (!text || text.trim().length === 0) {
    return [];
  }
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;
  /** Fence state at the start of the line being placed. */
  let openFence: string | undefined;

  /** Close the chunk in progress, reopening an in-flight fence in the next. */
  const flush = (fenceToReopen: string | undefined): void => {
    if (current.length === 0) {
      return;
    }
    if (fenceToReopen !== undefined) {
      current.push(closeFor(fenceToReopen));
    }
    chunks.push(current.join("\n"));
    current = [];
    currentLength = 0;
    if (fenceToReopen !== undefined) {
      current.push(fenceToReopen);
      currentLength = fenceToReopen.length;
    }
  };

  /**
   * Append one line. `reserve` is the room the closing fence will need once
   * this line is in place, which is why the caller computes the fence state
   * first: an opening fence must budget for its own close.
   */
  const push = (line: string, reserve: number): void => {
    const separator = current.length === 0 ? 0 : 1;
    if (currentLength + separator + line.length + reserve > maxLength) {
      flush(openFence);
    }
    current.push(line);
    currentLength += (current.length === 1 ? 0 : 1) + line.length;
  };

  for (const line of text.split("\n")) {
    const nextFence = fenceStateAfter(line, openFence);
    // Room the closing fence needs once this line is placed, which is why the
    // fence state is computed first: an opening fence must budget for its own
    // close.
    const closeCost = closeCostFor(nextFence);
    // Room the reopened fence takes at the head of a fresh chunk. Charged
    // against the state *before* this line, because that is the fence a flush
    // would carry over.
    const reopenCost = openFence === undefined ? 0 : openFence.length + 1;

    if (reopenCost + line.length + closeCost > maxLength) {
      // The line cannot fit even alone in a fresh chunk, so it cannot break on
      // a newline and is cut at the character level. The pieces are fragments
      // of one logical line, so the fence state does not advance across them.
      for (const piece of hardSplit(line, maxLength - reopenCost - closeCost)) {
        push(piece, closeCost);
      }
      openFence = nextFence;
      continue;
    }

    push(line, closeCost);
    openFence = nextFence;
  }

  // A trailing chunk holding nothing but a reopened fence would render as an
  // empty code block, so it is dropped rather than sent.
  const onlyReopenedFence =
    openFence !== undefined && current.length === 1 && current[0] === openFence;
  if (current.length > 0 && !onlyReopenedFence) {
    if (openFence !== undefined) {
      current.push(closeFor(openFence));
    }
    chunks.push(current.join("\n"));
  }

  return chunks.filter((chunk) => chunk.trim().length > 0);
}

/**
 * Cut an over-long line into pieces of at most `maxLength`, never splitting a
 * surrogate pair (which would emit a lone half and render as a replacement
 * character).
 */
function hardSplit(line: string, maxLength: number): string[] {
  const safeMax = Math.max(1, maxLength);
  const pieces: string[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    let end = Math.min(cursor + safeMax, line.length);
    if (
      end < line.length &&
      line.charCodeAt(end - 1) >= 0xd800 &&
      line.charCodeAt(end - 1) <= 0xdbff
    ) {
      end--;
    }
    pieces.push(line.slice(cursor, end));
    cursor = end;
  }
  return pieces;
}
