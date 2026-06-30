/**
 * Slack Block Kit rendering: mdast → Slack blocks.
 *
 * The channel-neutral parse (markdown → mdast) lives in `messaging/content`;
 * this module is Slack's "how". Slack's `markdown` block natively renders the
 * full GFM vocabulary — lists, task lists, code with language, blockquotes, and
 * even tables — so prose runs are forwarded as a `markdown` block carrying the
 * exact original GFM, sliced from the source by node position (no inline →
 * mrkdwn serializer to hand-roll). Content is broken out into a dedicated block
 * only when a richer native block renders it better than the markdown block can:
 *
 * - heading → `header` (a distinct, larger style), but only when it is plain
 *   text within the 150-char limit; a heading carrying inline formatting (links,
 *   code, bold) or longer than the cap stays in a `markdown` block, which keeps
 *   that formatting and has no length limit.
 * - GFM table → `table`, preserving per-cell inline formatting via `rich_text`
 *   cells and column alignment via `column_settings` (or a `markdown` block when
 *   it exceeds Slack's table limits).
 * - standalone image → `image`, which actually displays the picture; the
 *   markdown block would instead degrade `![alt](url)` to plain hyperlink text.
 * - thematic break → `divider`.
 *
 * Scope: this renderer enforces only Slack's documented *per-element* limits —
 * a header's 150 characters, a table's row / column / cell budgets. It does NOT
 * police whole-message size (total block count, or cumulative `markdown` text).
 * Those ceilings — the 50-block limit, and an undocumented cumulative-markdown
 * limit Slack surfaces as `msg_blocks_too_long` around ~13k characters — are the
 * transport's responsibility: `send.ts` posts the blocks and resends the
 * message as plain text if Slack rejects the payload. Keeping size policy at the
 * send boundary lets Slack stay the authority on its own limits and keeps this
 * module a straight mapping with no guessed byte ceiling.
 */

import type {
  ImageBlock,
  KnownBlock,
  RawTextElement,
  RichTextBlock,
  RichTextElement,
  TableBlock,
} from "@slack/types";
import type {
  Heading,
  Image,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableRow,
} from "mdast";

import { parseMarkdown } from "../../content/parse.js";

/** A `header` block's plain_text is capped at 150 characters. */
const SLACK_HEADER_MAX_CHARS = 150;
/**
 * Slack `table` blocks allow at most 100 rows (the mdast header row counts), 20
 * columns, and 10,000 cell characters — the 10k applies both per table and in
 * aggregate across every table in one message.
 */
const SLACK_TABLE_MAX_ROWS = 100;
const SLACK_TABLE_MAX_COLUMNS = 20;
const SLACK_TABLE_MAX_TOTAL_CHARS = 10_000;
/** An `image` block's `image_url` must be a publicly hosted URL of ≤3000 chars. */
const SLACK_IMAGE_URL_MAX_CHARS = 3000;
/** An `image` block's `alt_text` is capped at 2000 characters. */
const SLACK_IMAGE_ALT_MAX_CHARS = 2000;

/** Inline mdast node types that a `header` block (plain_text only) cannot represent. */
const HEADING_FORMATTING_TYPES = new Set([
  "strong",
  "emphasis",
  "delete",
  "inlineCode",
  "link",
  "image",
  "break",
  "html",
]);

/**
 * Render markdown / plain text into Slack Block Kit blocks, or `undefined` when
 * the input is empty so callers can skip the `blocks` field entirely.
 */
export function renderSlackBlocks(text: string): KnownBlock[] | undefined {
  if (!text || text.trim().length === 0) return undefined;
  const blocks = renderSlack(parseMarkdown(text), text);
  return blocks.length > 0 ? blocks : undefined;
}

/**
 * Render an mdast tree to Slack blocks. `source` is the original markdown the
 * tree was parsed from; prose runs are sliced from it by node position so the
 * `markdown` blocks carry the exact GFM the user wrote.
 */
export function renderSlack(tree: Root, source: string): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  let run: RootContent[] = [];
  let tableCharsUsed = 0;

  const flushRun = (): void => {
    const md = sliceRun(run, source);
    if (md.length > 0) blocks.push({ type: "markdown", text: md });
    run = [];
  };

  for (const node of tree.children) {
    if (node.type === "heading") {
      flushRun();
      blocks.push(headingBlock(node, source));
    } else if (node.type === "table") {
      flushRun();
      const built = tryTableBlock(node, tableCharsUsed);
      if (built) {
        blocks.push(built.block);
        tableCharsUsed += built.cellChars;
      } else {
        // Too big for a `table` block (Slack would reject it). Keep the content
        // as its raw table markdown so it still shows, just not as a rendered
        // table.
        const md = sliceNode(node, source).trim();
        if (md.length > 0) blocks.push({ type: "markdown", text: md });
      }
    } else if (node.type === "thematicBreak") {
      flushRun();
      blocks.push({ type: "divider" });
    } else if (node.type === "paragraph") {
      const images = imageBlocksFromParagraph(node);
      if (images) {
        flushRun();
        blocks.push(...images);
      } else {
        run.push(node);
      }
    } else {
      run.push(node);
    }
  }
  flushRun();

  return blocks;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Slice a node's exact source markdown using its parse position. */
function sliceNode(node: RootContent, source: string): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return "";
  return source.slice(start, end);
}

/**
 * Slice a run of consecutive ordinary (non-heading / non-table / non-rule /
 * non-image) nodes back to one markdown string, spanning the first node's start
 * to the last node's end so the original GFM — and the blank lines between nodes
 * — is preserved verbatim. Returns "" for an empty run.
 */
function sliceRun(run: RootContent[], source: string): string {
  if (run.length === 0) return "";
  const start = run[0]?.position?.start.offset;
  const end = run[run.length - 1]?.position?.end.offset;
  if (start === undefined || end === undefined) return "";
  return source.slice(start, end).trim();
}

/**
 * A heading node as a Slack block. A plain-text heading within the 150-char cap
 * becomes a `header` block (Slack's distinct, larger heading style). A heading
 * that carries inline formatting, or is longer than the cap, is rendered as a
 * `markdown` block from its raw GFM so the `#` still renders as a header while
 * keeping the formatting the `header` block (plain_text only) would drop.
 */
function headingBlock(node: Heading, source: string): KnownBlock {
  const plain = serializePlain(node.children);
  const isPlainText = node.children.every(
    (child) => !HEADING_FORMATTING_TYPES.has(child.type),
  );
  if (isPlainText && plain.length <= SLACK_HEADER_MAX_CHARS) {
    return {
      type: "header",
      text: {
        type: "plain_text",
        text: plain.length > 0 ? plain : " ",
        emoji: true,
      },
    };
  }
  return { type: "markdown", text: sliceNode(node, source).trim() };
}

/**
 * Build an `image` block per image when a paragraph is nothing but standalone
 * images (whitespace aside) whose URLs Slack can host, or `null` otherwise (so
 * the paragraph stays prose). Mixed prose-and-image paragraphs return `null` and
 * remain in a `markdown` block, where the image degrades to hyperlink text.
 */
function imageBlocksFromParagraph(node: Paragraph): ImageBlock[] | null {
  const images: Image[] = [];
  for (const child of node.children) {
    if (child.type === "image") {
      images.push(child);
    } else if (child.type === "text" && child.value.trim().length === 0) {
      continue;
    } else {
      return null;
    }
  }
  if (images.length === 0) return null;
  if (!images.every((img) => isHostableImageUrl(img.url))) return null;
  return images.map((img) => ({
    type: "image",
    image_url: img.url,
    // `alt_text` is required and must be non-empty; fall back when the image
    // has no alt (e.g. `![](url)`).
    alt_text: (img.alt ?? "").slice(0, SLACK_IMAGE_ALT_MAX_CHARS) || "image",
  }));
}

/** Whether a URL is an HTTP(S) link short enough for a Slack `image` block. */
function isHostableImageUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && url.length <= SLACK_IMAGE_URL_MAX_CHARS;
}

/**
 * Whether a URL is safe to emit in a Slack `link` element. Slack validates link
 * URLs and rejects the whole block on a relative path or bare fragment (e.g.
 * `./README.md`, `#section`), so only absolute schemes are linkable.
 */
function isLinkableUrl(url: string): boolean {
  return /^(https?|mailto|tel):/i.test(url);
}

type TableCell = RichTextBlock | RawTextElement;

/**
 * Build a Slack `table` block from a GFM table node, or `null` when it exceeds
 * Slack's limits (so the caller falls back to text). `charsUsed` is the running
 * per-message table-cell total; a table that would push it over 10,000 also
 * returns `null`. Cells carrying inline formatting (bold, links, code, …) are
 * `rich_text` so the formatting survives; plain cells stay `raw_text`. GFM
 * column alignment maps to `column_settings`.
 */
function tryTableBlock(
  node: Table,
  charsUsed: number,
): { block: TableBlock; cellChars: number } | null {
  const rows = node.children;
  const columnCount = Math.max(0, ...rows.map((row) => row.children.length));
  if (columnCount === 0 || columnCount > SLACK_TABLE_MAX_COLUMNS) return null;
  if (rows.length > SLACK_TABLE_MAX_ROWS) return null;

  const cellNodesAt = (row: TableRow, c: number): PhrasingContent[] =>
    row.children[c]?.children ?? [];

  const tableRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, c) =>
      cellBlock(cellNodesAt(row, c)),
    ),
  );
  // Slack's 10k budget counts the text actually emitted, which can differ from
  // the source (empty cells emit a space; empty-alt images emit their URL), so
  // measure the built cells rather than the source nodes.
  const cellChars = tableRows.reduce(
    (sum, row) =>
      sum + row.reduce((rowSum, cell) => rowSum + cellTextLength(cell), 0),
    0,
  );
  if (cellChars > SLACK_TABLE_MAX_TOTAL_CHARS) return null;
  if (charsUsed + cellChars > SLACK_TABLE_MAX_TOTAL_CHARS) return null;

  const columnSettings = columnSettingsFor(node, columnCount);
  const block: TableBlock = columnSettings
    ? { type: "table", rows: tableRows, column_settings: columnSettings }
    : { type: "table", rows: tableRows };
  return { block, cellChars };
}

/**
 * A table cell: `rich_text` when the cell carries inline formatting so bold /
 * italic / strikethrough / code / links survive, otherwise a plain `raw_text`
 * element. Both require at least one character.
 */
function cellBlock(nodes: PhrasingContent[]): TableCell {
  if (hasInlineFormatting(nodes)) {
    const elements = toRichText(nodes, undefined);
    return {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements:
            elements.length > 0 ? elements : [{ type: "text", text: " " }],
        },
      ],
    };
  }
  const text = serializePlain(nodes);
  return { type: "raw_text", text: text.length > 0 ? text : " " };
}

/**
 * Number of characters a built cell contributes to Slack's 10k per-message
 * table-cell budget — the text actually emitted, including link text (which for
 * empty-alt images is the URL), so the estimate never undercounts the payload.
 */
function cellTextLength(cell: TableCell): number {
  if (cell.type === "raw_text") return cell.text.length;
  let total = 0;
  for (const section of cell.elements) {
    if (section.type !== "rich_text_section") continue;
    for (const el of section.elements) {
      if (el.type === "text") total += el.text.length;
      else if (el.type === "link") total += (el.text ?? el.url).length;
    }
  }
  return total;
}

/** Column-alignment settings derived from GFM table alignment, or `undefined`. */
function columnSettingsFor(
  node: Table,
  columnCount: number,
): TableBlock["column_settings"] | undefined {
  const align = node.align ?? [];
  if (!align.some((a) => a === "left" || a === "center" || a === "right")) {
    return undefined;
  }
  return Array.from({ length: columnCount }, (_, c) => {
    const a = align[c];
    return a ? { align: a } : {};
  });
}

/** Whether any (possibly nested) inline node would render formatting in a cell. */
function hasInlineFormatting(nodes: PhrasingContent[]): boolean {
  for (const node of nodes) {
    if (
      node.type === "strong" ||
      node.type === "emphasis" ||
      node.type === "delete" ||
      node.type === "inlineCode" ||
      node.type === "link" ||
      node.type === "image"
    ) {
      return true;
    }
    if ("children" in node && hasInlineFormatting(node.children)) return true;
  }
  return false;
}

type RichTextStyle = NonNullable<RichTextElement["style"]>;

/** Render inline phrasing content to Slack `rich_text` elements, carrying style. */
function toRichText(
  nodes: PhrasingContent[],
  style: RichTextStyle | undefined,
): RichTextElement[] {
  const out: RichTextElement[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out.push(styledText(node.value, style));
        break;
      case "inlineCode":
        out.push(styledText(node.value, { ...style, code: true }));
        break;
      case "strong":
        out.push(...toRichText(node.children, { ...style, bold: true }));
        break;
      case "emphasis":
        out.push(...toRichText(node.children, { ...style, italic: true }));
        break;
      case "delete":
        out.push(...toRichText(node.children, { ...style, strike: true }));
        break;
      case "link": {
        const text = serializePlain(node.children);
        // Slack validates `link.url`; a relative/anchor URL (e.g. `./README.md`,
        // `#section`) makes the whole table block fail with `invalid_blocks` and
        // drops the entire message to plain text. Degrade an un-linkable URL to
        // its visible text so the rest of the table still renders.
        if (isLinkableUrl(node.url)) {
          const link: RichTextElement = { type: "link", url: node.url, text };
          out.push(style ? { ...link, style } : link);
        } else if (text.length > 0) {
          out.push(styledText(text, style));
        }
        break;
      }
      case "break":
        out.push(styledText("\n", style));
        break;
      case "image":
        // rich_text can't embed an image; degrade to a link to it (keeping the
        // URL), matching how the markdown block renders an image as a link.
        // An un-linkable URL would fail validation, so fall back to alt text.
        // With no alt the URL itself is the link text, so the user can still
        // see and click through to the image.
        if (node.url && isLinkableUrl(node.url)) {
          out.push({ type: "link", url: node.url, text: node.alt || node.url });
        } else if (node.alt) {
          out.push(styledText(node.alt, style));
        }
        break;
      default:
        if ("children" in node) {
          out.push(...toRichText(node.children as PhrasingContent[], style));
        }
    }
  }
  return out;
}

/** A `text` rich-text element, attaching `style` only when it sets something. */
function styledText(
  text: string,
  style: RichTextStyle | undefined,
): RichTextElement {
  const hasStyle = style && Object.values(style).some(Boolean);
  return hasStyle ? { type: "text", text, style } : { type: "text", text };
}

/** Flatten inline phrasing content to plain text (used for headers and plain cells). */
function serializePlain(nodes: PhrasingContent[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += node.value;
        break;
      case "inlineCode":
        out += node.value;
        break;
      case "break":
        out += " ";
        break;
      case "image":
        out += node.alt ?? "";
        break;
      case "strong":
      case "emphasis":
      case "delete":
      case "link":
        out += serializePlain(node.children);
        break;
      default:
        if ("children" in node) {
          out += serializePlain(node.children as PhrasingContent[]);
        }
    }
  }
  return out;
}
