/**
 * Clipboard payloads for a text selection inside rendered markdown.
 *
 * The browser's own `copy` serialization has two problems for prose that is
 * pasted elsewhere:
 *
 * - Its `text/html` flavor inlines the *computed* styles of every selected
 *   node and its ancestors, background colors included. A code block or
 *   blockquote therefore pastes into Outlook (Word engine) with grey shading.
 * - Its `text/plain` flavor is a flat text dump: block structure becomes a
 *   blank line after every block, list items included, and every marker,
 *   fence, and emphasis the rendered message showed is gone.
 *
 * Both payloads here are built from a clone of the selected DOM instead. The
 * HTML flavor keeps only semantic tags and the handful of attributes that
 * carry meaning. The plain flavor is markdown, so a paste into a
 * markdown-aware box (the composer, Slack, GitHub, Notion) round-trips the
 * formatting the reader selected.
 */

/** Attributes that carry meaning outside our stylesheet, per tag. */
const KEPT_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ["href"],
  img: ["src", "alt"],
  // A task list checkbox reads as a text field without its type.
  input: ["type", "checked", "disabled"],
  ol: ["start"],
  li: ["value"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
};

/**
 * Elements that never carry copyable content: marked chrome (the code block
 * copy control and the header row it sits in, whose language label the
 * markdown fence already states) and presentational duplicates (KaTeX renders
 * both a visual `aria-hidden` layer and an accessible MathML layer for one
 * formula; copying both would repeat the formula).
 *
 * Matching is by marker, not by tag: a consumer can render real content inside
 * a `<button>` (a workspace path that opens a file, a previewable image), and
 * dropping every button would silently omit it from the copy.
 */
function isChrome(element: Element): boolean {
  return (
    element.hasAttribute("data-copy-control") ||
    element.hasAttribute("data-code-block-header") ||
    element.getAttribute("aria-hidden") === "true"
  );
}

/** Drop every chrome element from a cloned fragment. */
function pruneChrome(root: ParentNode): void {
  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (isChrome(element)) {
      element.remove();
    }
  }
}

/**
 * Replace the buttons that survived pruning with their own children. Their
 * content is real, but `<button>` means nothing in a pasted document.
 */
function unwrapButtons(root: ParentNode): void {
  for (const button of Array.from(root.querySelectorAll("button"))) {
    const parent = button.parentNode;
    if (!parent) {
      continue;
    }
    while (button.firstChild) {
      parent.insertBefore(button.firstChild, button);
    }
    parent.removeChild(button);
  }
}

/**
 * Strip a cloned fragment down to semantic markup: every attribute outside
 * `KEPT_ATTRIBUTES` is dropped, so no class, inline style, or data attribute
 * survives.
 */
function stripAttributes(root: ParentNode): void {
  for (const element of Array.from(root.querySelectorAll("*"))) {
    const kept = KEPT_ATTRIBUTES[element.tagName.toLowerCase()] ?? [];
    for (const name of Array.from(element.getAttributeNames())) {
      if (!kept.includes(name)) {
        element.removeAttribute(name);
      }
    }
  }
}

const HEADING_LEVELS: Readonly<Record<string, number>> = {
  H1: 1,
  H2: 2,
  H3: 3,
  H4: 4,
  H5: 5,
  H6: 6,
};

/**
 * Tags that open their own block. Anything else is inline and joins the run
 * of text around it.
 */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DIV",
  "FIGURE",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TR",
  "UL",
]);

interface MarkdownBlock {
  /** Tag that produced the block, so joiners can keep nested lists tight. */
  tag: string;
  text: string;
}

function isElement(node: Node): node is Element {
  return node.nodeType === node.ELEMENT_NODE;
}

/**
 * Render the children of `node` as a list of markdown blocks. Runs of inline
 * content between block children collapse into a paragraph block; whitespace
 * that only separates block tags in the source collapses away entirely.
 */
function renderBlocks(node: Node): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let inline = "";

  const flushInline = () => {
    // Markers pushed outside their own padding can leave a doubled space
    // where the surrounding text already ended in one.
    const text = inline
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+$/gm, "")
      .trim();
    if (text !== "") {
      blocks.push({ tag: "P", text });
    }
    inline = "";
  };

  for (const child of Array.from(node.childNodes)) {
    if (isElement(child) && BLOCK_TAGS.has(child.tagName)) {
      flushInline();
      const text = renderBlock(child);
      if (text !== "") {
        blocks.push({ tag: child.tagName, text });
      }
      continue;
    }
    inline += renderInline(child);
  }
  flushInline();

  return blocks;
}

/** Join blocks the way markdown separates them: one blank line between. */
function joinBlocks(blocks: MarkdownBlock[]): string {
  return blocks.map((block) => block.text).join("\n\n");
}

/** Render the children of `node` as one markdown string. */
function renderContainer(node: Node): string {
  return joinBlocks(renderBlocks(node));
}

/** Render the children of `node` as a single line, for headings and cells. */
function renderOneLine(node: Node): string {
  return renderContainer(node)
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

function renderBlock(element: Element): string {
  const tag = element.tagName;
  if (tag === "HR") {
    return "---";
  }
  if (tag === "PRE") {
    return renderFencedCode(element);
  }
  if (tag === "TABLE") {
    return renderTable(element);
  }
  if (tag === "TR") {
    return renderTableRow(cellsOf(element));
  }
  if (tag === "UL" || tag === "OL") {
    return renderList(element);
  }
  if (tag === "LI") {
    // A list item cloned without its list, as happens when a selection starts
    // mid-list, still reads as one.
    return renderListItem(element, "- ");
  }
  if (tag === "BLOCKQUOTE") {
    return quoteLines(renderContainer(element));
  }
  const level = HEADING_LEVELS[tag];
  if (level !== undefined) {
    const heading = renderOneLine(element);
    return heading === "" ? "" : `${"#".repeat(level)} ${heading}`;
  }
  return renderContainer(element);
}

/** Prefix every line of a blockquote's content, blank lines included. */
function quoteLines(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

function renderList(list: Element): string {
  const ordered = list.tagName === "OL";
  const start = Number.parseInt(list.getAttribute("start") ?? "1", 10);
  const items = Array.from(list.children).filter(
    (child) => child.tagName === "LI",
  );
  let next = Number.isNaN(start) ? 1 : start;
  return items
    .map((item) => {
      if (!ordered) {
        return renderListItem(item, "- ");
      }
      const number = itemNumber(item, next);
      next = number + 1;
      return renderListItem(item, `${number}. `);
    })
    .join("\n");
}

/**
 * A list item's own ordinal when the renderer pinned one via `value`,
 * otherwise the count carried from the item above it. Counting from the
 * running position rather than the list's `start` keeps the items after a
 * pinned jump in sequence with the jump.
 */
function itemNumber(item: Element, next: number): number {
  const pinned = Number.parseInt(item.getAttribute("value") ?? "", 10);
  return Number.isNaN(pinned) ? next : pinned;
}

/**
 * The GFM task box for an item whose renderer emitted a checkbox, so a copied
 * checklist pastes back as a checklist.
 */
function taskBox(item: Element): string {
  const checkbox = Array.from(item.children).find(
    (child) =>
      child.tagName === "INPUT" && child.getAttribute("type") === "checkbox",
  );
  if (!checkbox) {
    return "";
  }
  const checked =
    (checkbox as HTMLInputElement).checked || checkbox.hasAttribute("checked");
  return checked ? "[x] " : "[ ] ";
}

/**
 * Render one list item: the marker opens the first line and every following
 * line is indented to the marker's width, which is what makes a nested list
 * nest.
 */
function renderListItem(item: Element, marker: string): string {
  const opener = `${marker}${taskBox(item)}`;
  const blocks = renderBlocks(item);
  let body = "";
  blocks.forEach((block, index) => {
    if (index > 0) {
      // A nested list belongs to the item above it, so it stays tight.
      body += block.tag === "UL" || block.tag === "OL" ? "\n" : "\n\n";
    }
    body += block.text;
  });
  const indent = " ".repeat(marker.length);
  return body
    .split("\n")
    .map((line, index) => {
      if (index === 0) {
        return `${opener}${line}`;
      }
      return line === "" ? "" : `${indent}${line}`;
    })
    .join("\n");
}

/**
 * Render a code block as a fence. The language comes from the
 * `language-<name>` class react-markdown puts on the inner `<code>`, and the
 * fence grows past any backtick run in the body so the block cannot be closed
 * early.
 */
function renderFencedCode(pre: Element): string {
  const code = pre.querySelector("code");
  const language = code ? codeLanguage(code) : "";
  const body = ((code ?? pre).textContent ?? "").replace(/\n+$/, "");
  const fence = "`".repeat(Math.max(3, longestBacktickRun(body) + 1));
  return `${fence}${language}\n${body}\n${fence}`;
}

function codeLanguage(code: Element): string {
  const match = /(?:^|\s)language-([\w+#.-]+)/.exec(
    code.getAttribute("class") ?? "",
  );
  return match ? match[1] : "";
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) {
    longest = Math.max(longest, run[0].length);
  }
  return longest;
}

function cellsOf(row: Element): Element[] {
  return Array.from(row.children).filter(
    (child) => child.tagName === "TD" || child.tagName === "TH",
  );
}

/** Render a table as GFM pipes, with a separator row under the header. */
function renderTable(table: Element): string {
  const rows = Array.from(table.querySelectorAll("tr")).map(cellsOf);
  if (rows.length === 0) {
    return "";
  }
  const width = Math.max(...rows.map((cells) => cells.length));
  const lines = [
    renderTableRow(rows[0], width),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
  ];
  for (const cells of rows.slice(1)) {
    lines.push(renderTableRow(cells, width));
  }
  return lines.join("\n");
}

function renderTableRow(cells: Element[], width = cells.length): string {
  const rendered = Array.from(
    { length: Math.max(width, cells.length) },
    (_, index) => (cells[index] ? renderCell(cells[index]) : ""),
  );
  return `| ${rendered.join(" | ")} |`;
}

/** A cell is one line, and its pipes are escaped so they stay content. */
function renderCell(cell: Element): string {
  return renderOneLine(cell).replace(/\|/g, "\\|");
}

/**
 * Emphasis already open around a node. Nesting the same marker twice is
 * ambiguous in markdown, so the inner one switches to the other spelling.
 */
interface EmphasisContext {
  em: boolean;
  strong: boolean;
}

const NO_EMPHASIS: EmphasisContext = { em: false, strong: false };

function renderInline(
  node: Node,
  context: EmphasisContext = NO_EMPHASIS,
): string {
  if (node.nodeType === node.TEXT_NODE) {
    return (node.textContent ?? "").replace(/\s+/g, " ");
  }
  if (!isElement(node)) {
    return "";
  }
  const tag = node.tagName;
  if (tag === "BR") {
    return "\n";
  }
  if (tag === "IMG") {
    return `![${node.getAttribute("alt") ?? ""}](${node.getAttribute("src") ?? ""})`;
  }
  if (tag === "STRONG" || tag === "B") {
    const inner = renderInlineChildren(node, { ...context, strong: true });
    return inner.trim() === ""
      ? inner
      : wrapEmphasis(inner, context.strong ? "__" : "**");
  }
  if (tag === "EM" || tag === "I") {
    const inner = renderInlineChildren(node, { ...context, em: true });
    return inner.trim() === ""
      ? inner
      : wrapEmphasis(inner, context.em ? "*" : "_");
  }
  const inner = renderInlineChildren(node, context);
  if (tag === "CODE") {
    return wrapCode(inner);
  }
  if (inner.trim() === "") {
    return inner;
  }
  if (tag === "DEL" || tag === "S" || tag === "STRIKE") {
    return wrapEmphasis(inner, "~~");
  }
  if (tag === "A") {
    return renderLink(node, inner);
  }
  return inner;
}

function renderInlineChildren(
  element: Element,
  context: EmphasisContext = NO_EMPHASIS,
): string {
  return Array.from(element.childNodes)
    .map((child) => renderInline(child, context))
    .join("");
}

/** Split off the whitespace around `text`, which markers may not enclose. */
function splitPadding(text: string): [string, string, string] {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!match) {
    return ["", text, ""];
  }
  return [match[1], match[2], match[3]];
}

function wrapEmphasis(text: string, marker: string): string {
  const [lead, core, trail] = splitPadding(text);
  return `${lead}${marker}${core}${marker}${trail}`;
}

/**
 * Wrap an inline code span. The delimiter grows past any backtick run in the
 * content, and a content edge that is itself a backtick gets a space so the
 * delimiter stays distinguishable.
 */
function wrapCode(text: string): string {
  const [lead, core, trail] = splitPadding(text);
  if (core === "") {
    return text;
  }
  const delimiter = "`".repeat(longestBacktickRun(core) + 1);
  const pad = core.startsWith("`") || core.endsWith("`") ? " " : "";
  return `${lead}${delimiter}${pad}${core}${pad}${delimiter}${trail}`;
}

/** An anchor whose text is its own href is an autolink and needs no wrapper. */
function renderLink(anchor: Element, text: string): string {
  const href = anchor.getAttribute("href") ?? "";
  const [lead, core, trail] = splitPadding(text);
  if (href === "" || href === core) {
    return text;
  }
  return `${lead}[${core}](${href})${trail}`;
}

export interface SelectionClipboardPayload {
  html: string;
  text: string;
}

/**
 * True when every end of `selection` lies inside `container`. A selection
 * that reaches outside is left to the browser, since building a payload from
 * only the inside part would silently drop the rest.
 */
export function isSelectionWithin(
  selection: Selection,
  container: Node,
): boolean {
  if (selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    if (
      !container.contains(range.startContainer) ||
      !container.contains(range.endContainer)
    ) {
      return false;
    }
  }
  return true;
}

function cloneSelection(
  selection: Selection,
  ownerDocument: Document,
): HTMLElement {
  const container = ownerDocument.createElement("div");
  for (let i = 0; i < selection.rangeCount; i++) {
    container.appendChild(selection.getRangeAt(i).cloneContents());
  }
  pruneChrome(container);
  unwrapButtons(container);
  return container;
}

/**
 * Build clean `text/html` and markdown `text/plain` payloads for `selection`.
 * Each flavor gets its own clone, since markdown reads the class names that
 * the HTML flavor strips. The live DOM is untouched.
 */
export function buildSelectionClipboardPayload(
  selection: Selection,
  ownerDocument: Document,
): SelectionClipboardPayload {
  const htmlRoot = cloneSelection(selection, ownerDocument);
  stripAttributes(htmlRoot);
  const markdownRoot = cloneSelection(selection, ownerDocument);
  return {
    html: htmlRoot.innerHTML,
    text: renderContainer(markdownRoot).trim(),
  };
}
