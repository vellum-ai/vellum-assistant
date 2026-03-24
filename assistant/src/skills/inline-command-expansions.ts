/**
 * Canonical parser for inline command expansion tokens in skill bodies.
 *
 * Syntax: !\`command\`
 *
 * These tokens are parsed from the markdown body of a SKILL.md file (after
 * frontmatter extraction). Tokens inside fenced code blocks are ignored so
 * that documentation examples or literal snippets do not accidentally execute.
 *
 * The parser fails closed on malformed tokens: unmatched backticks, empty
 * commands, or nested backticks that make the command text ambiguous are
 * rejected rather than best-effort expanded.
 */

import { getLogger } from "../util/logger.js";

const log = getLogger("inline-command-expansions");

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single parsed inline command expansion descriptor. */
export interface InlineCommandExpansion {
  /** The raw command text between the backticks (trimmed). */
  command: string;
  /** Byte offset of the `!` character in the original body string. */
  startOffset: number;
  /** Byte offset one past the closing backtick in the original body string. */
  endOffset: number;
  /** Stable placeholder ID derived from encounter order (0-indexed). */
  placeholderId: number;
}

/** Result of parsing a skill body for inline command expansions. */
export interface InlineCommandExpansionResult {
  /** Successfully parsed expansion descriptors, in encounter order. */
  expansions: InlineCommandExpansion[];
  /** Malformed tokens that were rejected (fail-closed). */
  errors: InlineCommandExpansionError[];
}

/** A malformed inline command expansion token. */
export interface InlineCommandExpansionError {
  /** The raw matched text that was rejected. */
  raw: string;
  /** Byte offset in the original body. */
  offset: number;
  /** Human-readable reason for rejection. */
  reason: string;
}

// ─── Fenced code block stripping ──────────────────────────────────────────────

/**
 * Build a set of character ranges that fall inside fenced code blocks.
 * A fenced code block starts with a line matching ``` (with optional info
 * string) and ends with a line matching ``` (or end of string).
 */
function buildFencedCodeRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // Match fenced code block delimiters: ``` optionally followed by info string
  const fenceRe = /^(`{3,}|~{3,})(.*)?$/gm;
  let openFence: { index: number; delimiter: string } | undefined;

  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(body)) !== null) {
    const delimiter = match[1];
    if (openFence === undefined) {
      // Opening fence
      openFence = {
        index: match.index,
        delimiter: delimiter[0].repeat(delimiter.length),
      };
    } else if (
      delimiter[0] === openFence.delimiter[0] &&
      delimiter.length >= openFence.delimiter.length &&
      // Closing fence must be bare (no info string after it)
      (!match[2] || match[2].trim() === "")
    ) {
      // Closing fence — range covers from opening fence to end of closing fence line
      ranges.push([openFence.index, match.index + match[0].length]);
      openFence = undefined;
    }
    // Otherwise ignore (nested fence-like lines inside a code block)
  }

  // If a fence was opened but never closed, treat everything from the opening
  // fence to EOF as inside a code block.
  if (openFence !== undefined) {
    ranges.push([openFence.index, body.length]);
  }

  return ranges;
}

function isInsideFencedCode(
  offset: number,
  ranges: Array<[number, number]>,
): boolean {
  for (const [start, end] of ranges) {
    if (offset >= start && offset < end) return true;
  }
  return false;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse inline command expansion tokens (`!\`...\``) from a skill body.
 *
 * The body must be the markdown content _after_ frontmatter has been stripped.
 * Tokens inside fenced code blocks are skipped.
 *
 * Returns both the successfully parsed expansions and any malformed tokens
 * that were rejected (fail-closed).
 */
export function parseInlineCommandExpansions(
  body: string,
): InlineCommandExpansionResult {
  const expansions: InlineCommandExpansion[] = [];
  const errors: InlineCommandExpansionError[] = [];

  const fencedRanges = buildFencedCodeRanges(body);

  // Match !\`...\` tokens. The regex captures the content between the backticks.
  // We use a non-greedy match to find the first closing backtick.
  const tokenRe = /!\`([^`]*)\`/g;

  let match: RegExpExecArray | null;
  let placeholderCounter = 0;

  while ((match = tokenRe.exec(body)) !== null) {
    const startOffset = match.index;
    const endOffset = startOffset + match[0].length;
    const rawCommand = match[1];

    // Skip tokens inside fenced code blocks
    if (isInsideFencedCode(startOffset, fencedRanges)) {
      continue;
    }

    // Fail closed: empty command
    if (rawCommand.trim().length === 0) {
      errors.push({
        raw: match[0],
        offset: startOffset,
        reason: "Empty command text",
      });
      continue;
    }

    // Fail closed: nested backticks (would make command text ambiguous)
    if (rawCommand.includes("`")) {
      errors.push({
        raw: match[0],
        offset: startOffset,
        reason: "Nested backticks in command text",
      });
      continue;
    }

    expansions.push({
      command: rawCommand.trim(),
      startOffset,
      endOffset,
      placeholderId: placeholderCounter++,
    });
  }

  // Also detect malformed tokens: !\` without a closing backtick.
  // These are unmatched opening tokens that didn't match the regex above.
  const unmatchedRe = /!\`/g;
  const matchedStarts = new Set<number>();
  // Re-run the token regex to collect all matched positions
  tokenRe.lastIndex = 0;
  while ((match = tokenRe.exec(body)) !== null) {
    matchedStarts.add(match.index);
  }

  let unmatchedMatch: RegExpExecArray | null;
  while ((unmatchedMatch = unmatchedRe.exec(body)) !== null) {
    const offset = unmatchedMatch.index;

    // Skip if this was already matched as a complete token
    if (matchedStarts.has(offset)) continue;

    // Skip if inside a fenced code block
    if (isInsideFencedCode(offset, fencedRanges)) continue;

    errors.push({
      raw: body.slice(offset, Math.min(offset + 40, body.length)),
      offset,
      reason: "Unmatched opening backtick (no closing backtick found)",
    });
  }

  if (errors.length > 0) {
    log.warn(
      { errorCount: errors.length, errors },
      "Malformed inline command expansion tokens detected",
    );
  }

  return { expansions, errors };
}
