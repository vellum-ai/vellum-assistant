/**
 * Telegram rich-message rendering: canonical mdast → Telegram rich HTML.
 *
 * The channel-neutral parse (markdown → mdast) lives in `messaging/content`;
 * this module is Telegram's "how". Telegram Bot API 10.1 rich messages accept
 * an `html` field whose text content is literal — so `$100`, `==x==`, `||y||`,
 * and `<` render exactly as the agent wrote them. The sibling `markdown` field
 * is a GFM *superset* that would instead reinterpret those as math, highlight,
 * spoiler, and inline HTML, silently changing content.
 *
 * Rendering goes through the standard unified pipeline — `mdast-util-to-hast`
 * then `hast-util-to-html` — so HTML escaping and serialization are owned by the
 * maintained serializer rather than hand-written. `telegramizeHast` then applies
 * the few documented places where Telegram's vocabulary differs from generic
 * HTML:
 *   - tables use `<tr>` directly, with no `<thead>`/`<tbody>` wrappers;
 *   - task-list items use a bare `<input type="checkbox">` — no `disabled`
 *     attribute and no list classes;
 *   - a code block without a language is a bare `<pre>`; a language is carried
 *     on a nested `<code class="language-…">`;
 *   - images are standalone media blocks, so an image-only paragraph is
 *     unwrapped (`<p><img></p>` → `<img>`) rather than nested inside `<p>`.
 *
 * `useNamedReferences: false` emits numeric character references. Telegram
 * supports every numeric reference but only a fixed set of 13 named entities,
 * and its docs are ambiguous about whether `&quot;` is among them, so numeric
 * references are the unambiguously-safe choice.
 *
 * Verified against the official Bot API docs:
 *   https://core.telegram.org/bots/api#rich-html-style
 *   https://core.telegram.org/bots/api#inputrichmessage
 */

import type { Element, ElementContent, Root, RootContent } from "hast";
import { toHtml } from "hast-util-to-html";
import { toHast } from "mdast-util-to-hast";

import { parseMarkdown } from "../../content/parse.js";

/**
 * Render markdown / plain text into a Telegram rich-message HTML string, or
 * `undefined` when there is no renderable content so callers can skip the rich
 * path entirely.
 */
export function renderTelegramHtml(text: string): string | undefined {
  if (!text || text.trim().length === 0) return undefined;

  const hast = toHast(parseMarkdown(text), {
    handlers: {
      // remark-gfm parses literal `<tag>` markup the agent typed as `html`
      // nodes. Agent-authored HTML is not executed as Telegram markup; emitting
      // it as text makes the serializer escape it so it renders verbatim — the
      // same outcome as the web client, which parses with remark-gfm and no
      // `rehype-raw`.
      html: (_state, node: { value: string }) => ({
        type: "text",
        value: node.value,
      }),
    },
  });

  // `toHast` is typed to return any hast node, but a root input always yields a
  // root; the guard narrows the type without changing behaviour.
  if (hast.type !== "root") return undefined;

  telegramizeHast(hast);

  const html = toHtml(hast, {
    characterReferences: { useNamedReferences: false },
  });
  return html.length > 0 ? html : undefined;
}

// ---------------------------------------------------------------------------
// Telegram-specific hast adjustments
// ---------------------------------------------------------------------------

/**
 * Block-level tags in the generic HTML the serializer produces. Whitespace that
 * only separates block-level siblings is layout-insignificant; whitespace
 * between inline content (text, `<strong>`, `<em>`, `<a>`, …) is meaningful and
 * must be preserved.
 */
const BLOCK_TAGS = new Set([
  "blockquote",
  "details",
  "figure",
  "figcaption",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "summary",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** Tags whose text content is preformatted, so whitespace is always significant. */
const PREFORMATTED_TAGS = new Set(["pre", "code"]);

function telegramizeHast(root: Root): void {
  processNode(root);
}

function processNode(node: Root | Element): void {
  for (const child of node.children) {
    if (child.type === "element") processNode(child);
  }

  if (node.type === "element") {
    switch (node.tagName) {
      case "table":
        unwrapTableSections(node);
        break;
      case "pre":
        normalizeCodeBlock(node);
        break;
      case "input":
        if (node.properties) delete node.properties.disabled;
        break;
      case "ul":
      case "ol":
        stripTaskListClasses(node);
        break;
      case "li":
        stripTaskListClasses(node);
        normalizeTaskItemSpacing(node);
        break;
    }
  }

  unwrapImageParagraphs(node);
  stripStructuralWhitespace(node);
}

/** Lift `<tr>` rows out of `<thead>`/`<tbody>`, which Telegram does not support. */
function unwrapTableSections(table: Element): void {
  const rows: ElementContent[] = [];
  for (const child of table.children) {
    if (
      child.type === "element" &&
      (child.tagName === "thead" || child.tagName === "tbody")
    ) {
      rows.push(...child.children);
    } else {
      rows.push(child);
    }
  }
  table.children = rows;
}

function normalizeCodeBlock(pre: Element): void {
  const code = pre.children.find(
    (child): child is Element =>
      child.type === "element" && child.tagName === "code",
  );
  if (!code) return;

  const last = code.children[code.children.length - 1];
  if (last?.type === "text" && last.value.endsWith("\n")) {
    last.value = last.value.slice(0, -1);
  }

  const className = code.properties?.className;
  const hasLanguage =
    Array.isArray(className) &&
    className.some(
      (name) => typeof name === "string" && name.startsWith("language-"),
    );
  // A bare code block has no language to carry, so the `<code>` wrapper is
  // dropped — Telegram renders fixed-width text from `<pre>` alone and only
  // honours a language on a nested `<code>`.
  if (!hasLanguage) {
    pre.children = code.children;
  }
}

function stripTaskListClasses(element: Element): void {
  const className = element.properties?.className;
  if (!Array.isArray(className) || !element.properties) return;
  const kept = className.filter(
    (name) => name !== "contains-task-list" && name !== "task-list-item",
  );
  if (kept.length > 0) {
    element.properties.className = kept;
  } else {
    delete element.properties.className;
  }
}

/**
 * Drop the whitespace that GFM inserts between a task-list checkbox and its
 * label. Telegram's documented checklist form places the label directly after
 * the input (`<input type="checkbox" checked>Checked checkbox`), so the leading
 * space is removed to match.
 */
function normalizeTaskItemSpacing(li: Element): void {
  const [first, second] = li.children;
  if (
    first?.type === "element" &&
    first.tagName === "input" &&
    first.properties?.type === "checkbox" &&
    second?.type === "text" &&
    second.value.trim().length === 0
  ) {
    li.children.splice(1, 1);
  }
}

/**
 * Lift the `<img>` out of an image-only paragraph. Telegram's rich HTML treats
 * images as standalone media blocks and does not accept `<img>` nested inside a
 * `<p>`; the generic serializer wraps a standalone Markdown image in `<p>`, so
 * an `<p><img></p>` is flattened to a top-level `<img>`. A paragraph that mixes
 * an image with text is left intact — its surrounding prose still needs `<p>`.
 */
function unwrapImageParagraphs(node: Root | Element): void {
  const lifted: Array<RootContent | ElementContent> = [];
  for (const child of node.children) {
    if (
      child.type === "element" &&
      child.tagName === "p" &&
      isImageOnlyParagraph(child)
    ) {
      for (const grandchild of child.children) {
        if (grandchild.type === "element" && grandchild.tagName === "img") {
          lifted.push(grandchild);
        }
      }
    } else {
      lifted.push(child);
    }
  }
  node.children = lifted as Element["children"];
}

function isImageOnlyParagraph(paragraph: Element): boolean {
  let hasImage = false;
  for (const child of paragraph.children) {
    if (child.type === "text") {
      if (child.value.trim().length > 0) return false;
    } else if (child.type === "element" && child.tagName === "img") {
      hasImage = true;
    } else {
      return false;
    }
  }
  return hasImage;
}

/**
 * Remove whitespace-only text nodes that merely separate block-level siblings —
 * the generic serializer inserts newlines between block elements, but Telegram
 * renders those source newlines as literal text. Whitespace flanked by inline
 * content on both sides (e.g. the space in `<strong>x</strong> <em>y</em>`) is
 * meaningful and preserved, and preformatted (`<pre>`/`<code>`) whitespace is
 * always left untouched.
 */
function stripStructuralWhitespace(node: Root | Element): void {
  if (node.type === "element" && PREFORMATTED_TAGS.has(node.tagName)) return;

  const children = node.children;
  node.children = children.filter((child, index) => {
    if (child.type !== "text" || child.value.trim().length > 0) return true;
    const prev = children[index - 1];
    const next = children[index + 1];
    return (
      prev !== undefined &&
      next !== undefined &&
      isInlineContent(prev) &&
      isInlineContent(next)
    );
  }) as Element["children"];
}

function isInlineContent(node: RootContent | ElementContent): boolean {
  if (node.type === "text") return node.value.trim().length > 0;
  if (node.type === "element") return !BLOCK_TAGS.has(node.tagName);
  return false;
}
