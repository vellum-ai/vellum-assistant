/**
 * Telegram rich-message rendering: mdast → Telegram rich HTML.
 *
 * The channel-neutral parse (markdown → mdast) lives in `messaging/content`;
 * this module is Telegram's "how". Telegram Bot API 10.1 rich messages accept
 * either an `html` or a `markdown` field, but Telegram's "Rich Markdown" is a
 * *superset* of GFM: it reinterprets `$…$` as math, `==x==` as highlight,
 * `||x||` as spoiler, and parses inline HTML. Forwarding canonical GFM into that
 * dialect would silently change content (a `$100` currency range becomes math),
 * and the send still succeeds so the plain-text fallback never fires.
 *
 * HTML mode avoids this entirely: the docs state *"Markdown isn't parsed inside
 * block HTML tags"*, so text content between tags is literal — `$100`, `==`,
 * `||`, and escaped `<` render exactly as written. We therefore render each
 * mdast node to Telegram's documented HTML vocabulary and HTML-escape every text
 * run, giving exact fidelity to what the agent emitted.
 *
 * Why a hand-rolled serializer instead of `mdast-util-to-hast` + a generic HTML
 * stringifier: Telegram supports only a fixed, non-standard tag set — tables use
 * `<table><tr><th|td>` with **no** `<thead>`/`<tbody>` wrappers, and only a
 * handful of named entities are allowed. A general mdast→HTML converter emits
 * the wrapper tags and a broader entity set, so it would need post-processing
 * that is more code (and more surprising) than mapping the nodes we actually
 * emit directly to Telegram's vocabulary — the same approach the Slack adapter
 * takes for Block Kit.
 *
 * Wire shapes verified against the official Bot API docs:
 *   - Rich HTML tag set / entities: https://core.telegram.org/bots/api#rich-message-formatting-options
 *   - InputRichMessage (html field): https://core.telegram.org/bots/api#inputrichmessage
 */

import type {
  AlignType,
  Blockquote,
  Code,
  Heading,
  List,
  ListItem,
  PhrasingContent,
  RootContent,
  Table,
  TableCell,
  TableRow,
} from "mdast";

import { parseMarkdown } from "../../content/parse.js";

/**
 * Render markdown / plain text into a Telegram rich-message HTML string, or
 * `undefined` when there is no renderable content so callers can skip the rich
 * path entirely.
 */
export function renderTelegramHtml(text: string): string | undefined {
  if (!text || text.trim().length === 0) return undefined;
  const html = renderFlow(parseMarkdown(text).children);
  return html.length > 0 ? html : undefined;
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * Escape text for Telegram rich HTML. Telegram accepts all numeric character
 * references but only a small set of named ones; `&`, `<`, `>`, `"`, and `'`
 * all map to supported named entities, which covers everything that needs
 * escaping in element text and attribute values.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// Block-level rendering
// ---------------------------------------------------------------------------

/** Render a sequence of block-level nodes to concatenated HTML. */
function renderFlow(nodes: RootContent[]): string {
  let out = "";
  for (const node of nodes) out += renderBlock(node);
  return out;
}

function renderBlock(node: RootContent): string {
  switch (node.type) {
    case "paragraph":
      return `<p>${renderPhrasing(node.children)}</p>`;
    case "heading":
      return renderHeading(node);
    case "blockquote":
      return `<blockquote>${renderContainer(node)}</blockquote>`;
    case "list":
      return renderList(node);
    case "code":
      return renderCode(node);
    case "table":
      return renderTable(node);
    case "thematicBreak":
      return "<hr/>";
    // Raw HTML authored in the markdown is treated as literal text so a stray
    // `<tag>` renders verbatim rather than injecting unsupported markup.
    case "html":
      return escapeHtml(node.value);
    default:
      return "";
  }
}

function renderHeading(node: Heading): string {
  const depth = node.depth;
  return `<h${depth}>${renderPhrasing(node.children)}</h${depth}>`;
}

function renderCode(node: Code): string {
  const lang = node.lang?.trim();
  const body = escapeHtml(node.value);
  // Per the docs, a programming language is specified via nested pre + code; a
  // standalone code tag cannot carry one.
  if (lang) {
    return `<pre><code class="language-${escapeHtml(lang)}">${body}</code></pre>`;
  }
  return `<pre>${body}</pre>`;
}

function renderList(node: List): string {
  const tag = node.ordered ? "ol" : "ul";
  const items = node.children.map(renderListItem).join("");
  if (node.ordered && node.start != null && node.start !== 1) {
    return `<ol start="${node.start}">${items}</ol>`;
  }
  return `<${tag}>${items}</${tag}>`;
}

function renderListItem(node: ListItem): string {
  // GFM task-list items carry a boolean `checked`; render Telegram's supported
  // checkbox input ahead of the item content.
  const checkbox =
    node.checked == null
      ? ""
      : `<input type="checkbox"${node.checked ? " checked" : ""}>`;
  return `<li>${checkbox}${renderContainer(node)}</li>`;
}

/**
 * Render the children of a list item or blockquote. Top-level paragraphs are
 * emitted inline (separated by `<br>` so loose items keep their spacing) rather
 * than wrapped in `<p>`, matching Telegram's examples; nested block content
 * (sub-lists, code, quotes) renders as its own block.
 */
function renderContainer(node: ListItem | Blockquote): string {
  let out = "";
  let prevInline = false;
  for (const child of node.children) {
    if (child.type === "paragraph") {
      if (prevInline) out += "<br><br>";
      out += renderPhrasing(child.children);
      prevInline = true;
    } else {
      out += renderBlock(child);
      prevInline = false;
    }
  }
  return out;
}

function renderTable(node: Table): string {
  const rows = node.children
    .map((row, index) => renderTableRow(row, index === 0, node.align))
    .join("");
  return `<table>${rows}</table>`;
}

function renderTableRow(
  row: TableRow,
  isHeader: boolean,
  align: (AlignType | null | undefined)[] | null | undefined,
): string {
  const tag = isHeader ? "th" : "td";
  const cells = row.children
    .map((cell, column) => renderTableCell(cell, tag, align?.[column]))
    .join("");
  return `<tr>${cells}</tr>`;
}

function renderTableCell(
  cell: TableCell,
  tag: "th" | "td",
  align: AlignType | null | undefined,
): string {
  const attr = align ? ` align="${align}"` : "";
  return `<${tag}${attr}>${renderPhrasing(cell.children)}</${tag}>`;
}

// ---------------------------------------------------------------------------
// Inline (phrasing) rendering
// ---------------------------------------------------------------------------

function renderPhrasing(nodes: PhrasingContent[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += escapeHtml(node.value);
        break;
      case "strong":
        out += `<b>${renderPhrasing(node.children)}</b>`;
        break;
      case "emphasis":
        out += `<i>${renderPhrasing(node.children)}</i>`;
        break;
      case "delete":
        out += `<s>${renderPhrasing(node.children)}</s>`;
        break;
      case "inlineCode":
        out += `<code>${escapeHtml(node.value)}</code>`;
        break;
      case "link":
        out += `<a href="${escapeHtml(node.url)}">${renderPhrasing(node.children)}</a>`;
        break;
      // Telegram renders images only as standalone media blocks, not inline, so
      // an inline image degrades to its alt text.
      case "image":
        out += escapeHtml(node.alt ?? "");
        break;
      case "break":
        out += "<br/>";
        break;
      case "html":
        out += escapeHtml(node.value);
        break;
      default:
        if ("children" in node) {
          out += renderPhrasing(node.children as PhrasingContent[]);
        }
    }
  }
  return out;
}
