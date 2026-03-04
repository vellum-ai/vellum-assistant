/**
 * Converts plain or markdown-formatted text into Slack Block Kit blocks.
 *
 * Slack's `mrkdwn` format is close to markdown but not identical.
 * This utility splits text into logical sections (paragraphs, code blocks,
 * headings) and wraps each in the appropriate Block Kit block type.
 */

import { type Block, BlockKitBuilder } from "./block-kit-builder.js";

/**
 * Convert a markdown/plain-text string into an array of Block Kit blocks.
 *
 * Strategy:
 * 1. Split the input into logical segments separated by blank lines.
 * 2. Fenced code blocks (``` ... ```) become section blocks with code
 *    wrapped in triple backticks (Slack mrkdwn supports these).
 * 3. Lines starting with `#` become header blocks (plain_text).
 * 4. Everything else becomes mrkdwn section blocks.
 * 5. Dividers are inserted between logical sections for readability.
 */
export function textToBlocks(text: string): Block[] {
  if (!text || text.trim().length === 0) return [];

  const segments = splitIntoSegments(text);
  const builder = new BlockKitBuilder();

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    if (i > 0) {
      builder.divider();
    }

    if (segment.type === "code") {
      // Wrap in triple backticks for Slack mrkdwn rendering
      const lang = segment.lang ? segment.lang : "";
      const codeText = "```" + lang + "\n" + segment.content + "\n```";
      builder.section(codeText);
    } else if (segment.type === "header") {
      builder.header(segment.content);
    } else {
      // Convert markdown formatting to Slack mrkdwn
      builder.section(markdownToMrkdwn(segment.content));
    }
  }

  return builder.toBlocks();
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface TextSegment {
  type: "text";
  content: string;
}

interface CodeSegment {
  type: "code";
  content: string;
  lang?: string;
}

interface HeaderSegment {
  type: "header";
  content: string;
}

type Segment = TextSegment | CodeSegment | HeaderSegment;

// ---------------------------------------------------------------------------
// Segment splitting
// ---------------------------------------------------------------------------

/**
 * Parse the input text into an ordered list of segments, distinguishing
 * fenced code blocks, headers, and regular text paragraphs.
 */
function splitIntoSegments(text: string): Segment[] {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  let currentTextLines: string[] = [];

  function flushText(): void {
    const joined = currentTextLines.join("\n").trim();
    if (joined.length > 0) {
      segments.push({ type: "text", content: joined });
    }
    currentTextLines = [];
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = line.match(/^```(\w*)\s*$/);

    if (fenceMatch) {
      flushText();
      const lang = fenceMatch[1] || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].match(/^```\s*$/)) {
        codeLines.push(lines[i]);
        i++;
      }
      segments.push({ type: "code", content: codeLines.join("\n"), lang });
      i++; // skip closing fence
      continue;
    }

    // Detect markdown headings (# through ###)
    const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (headingMatch) {
      flushText();
      segments.push({ type: "header", content: headingMatch[1].trim() });
      i++;
      continue;
    }

    currentTextLines.push(line);
    i++;
  }

  flushText();
  return segments;
}

// ---------------------------------------------------------------------------
// Markdown → Slack mrkdwn conversion
// ---------------------------------------------------------------------------

/**
 * Convert common markdown formatting to Slack mrkdwn equivalents.
 *
 * Slack mrkdwn differences from standard markdown:
 * - Bold: *text* (not **text**)
 * - Italic: _text_ (same)
 * - Strikethrough: ~text~ (same)
 * - Inline code: `text` (same)
 * - Links: <url|text> (not [text](url))
 */
function markdownToMrkdwn(text: string): string {
  let result = text;

  // Convert markdown links [text](url) → Slack <url|text>
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, linkText, url) => `<${url}|${linkText}>`,
  );

  // Convert **bold** → *bold* (Slack mrkdwn bold)
  // Must run before single-star italic conversion
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");

  return result;
}
