/**
 * Lightweight Block Kit block generation for Slack channel replies.
 *
 * The gateway's text-to-blocks utility handles the full conversion, but
 * the assistant pre-generates blocks so the gateway can pass them through
 * without re-parsing. This keeps the conversion logic self-contained and
 * avoids the gateway needing to distinguish pre-formatted from raw text.
 */

// ---------------------------------------------------------------------------
// Block types (mirrors gateway/src/slack/block-kit-builder.ts)
// ---------------------------------------------------------------------------

interface TextObject {
  type: "mrkdwn" | "plain_text";
  text: string;
}

interface SectionBlock {
  type: "section";
  text: TextObject;
}

interface DividerBlock {
  type: "divider";
}

interface HeaderBlock {
  type: "header";
  text: TextObject;
}

type Block = SectionBlock | DividerBlock | HeaderBlock;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert markdown/plain text into Slack Block Kit blocks.
 *
 * Returns undefined when the input is empty so callers can
 * skip sending the `blocks` field entirely.
 */
export function textToSlackBlocks(text: string): Block[] | undefined {
  if (!text || text.trim().length === 0) return undefined;

  const segments = splitIntoSegments(text);
  const blocks: Block[] = [];

  for (let i = 0; i < segments.length; i++) {
    if (i > 0) {
      blocks.push({ type: "divider" });
    }

    const segment = segments[i];

    if (segment.type === "code") {
      const lang = segment.lang ?? "";
      const codeText = "```" + lang + "\n" + segment.content + "\n```";
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: codeText },
      });
    } else if (segment.type === "header") {
      blocks.push({
        type: "header",
        text: { type: "plain_text", text: segment.content },
      });
    } else {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: markdownToMrkdwn(segment.content) },
      });
    }
  }

  return blocks.length > 0 ? blocks : undefined;
}

/**
 * Detect whether a callback URL points to the gateway's Slack delivery endpoint.
 */
export function isSlackCallbackUrl(callbackUrl: string): boolean {
  try {
    const url = new URL(callbackUrl);
    return (
      url.pathname === "/deliver/slack" ||
      url.pathname.startsWith("/deliver/slack?")
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internals
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

function markdownToMrkdwn(text: string): string {
  let result = text;
  // [text](url) → <url|text>
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, linkText, url) => `<${url}|${linkText}>`,
  );
  // **bold** → *bold*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  return result;
}
