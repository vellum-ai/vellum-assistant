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
 * markdown fence already states, plus anything a consumer marks with
 * `data-copy-exclude`, such as a message's hover controls or its timestamp)
 * and presentational duplicates (KaTeX renders both a visual `aria-hidden`
 * layer and an accessible MathML layer for one formula; copying both would
 * repeat the formula).
 *
 * Matching is by marker, not by tag: a consumer can render real content inside
 * a `<button>` (a workspace path that opens a file, a previewable image), and
 * dropping every button would silently omit it from the copy.
 */
function isChrome(element: Element): boolean {
  return (
    element.hasAttribute("data-copy-control") ||
    element.hasAttribute("data-code-block-header") ||
    element.hasAttribute("data-copy-exclude") ||
    element.getAttribute("aria-hidden") === "true"
  );
}

/**
 * Elements that carry content even when they hold no text. A selection whose
 * outside part is whitespace but includes one of these is still a selection
 * that reaches beyond `container`.
 */
const VOID_CONTENT_TAGS = "img, input, svg, video, audio, canvas, iframe";

/**
 * Embedded documents (a rendered diagram, an embedded player) hold nothing the
 * clipboard can carry: their content belongs to another document, so a copy
 * keeps only an empty frame.
 */
const EMBEDDED_DOCUMENT_TAGS = "iframe, object, embed";

/**
 * Wrappers worth dropping once they are empty. Structural tags stay: an empty
 * table cell, list item, or heading is part of the shape the reader selected.
 */
const DROPPABLE_WHEN_EMPTY: ReadonlySet<string> = new Set([
  "ARTICLE",
  "ASIDE",
  "DIV",
  "FIGURE",
  "FOOTER",
  "HEADER",
  "P",
  "SECTION",
  "SPAN",
]);

/** True when `element` holds neither text nor a self-contained element. */
function isEmptyWrapper(element: Element): boolean {
  return (
    DROPPABLE_WHEN_EMPTY.has(element.tagName) &&
    element.textContent?.trim() === "" &&
    element.querySelector(`br, hr, ${VOID_CONTENT_TAGS}`) === null
  );
}

/**
 * Drop every chrome element from a cloned fragment, then the wrappers left
 * holding nothing, innermost first, so a pruned embed does not paste as a run
 * of empty blocks.
 */
function pruneChrome(root: ParentNode): void {
  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (isChrome(element)) {
      element.remove();
    }
  }
  for (const embed of Array.from(
    root.querySelectorAll(EMBEDDED_DOCUMENT_TAGS),
  )) {
    embed.remove();
  }
  for (const element of Array.from(root.querySelectorAll("*")).reverse()) {
    if (isEmptyWrapper(element)) {
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

/**
 * Write the clean flavors for the part of the current selection that lies
 * inside `container`, and report whether it did.
 *
 * A `copy` handler calls `preventDefault()` on a `true` return, so the
 * browser's own serialization (which inlines computed colors, background
 * colors, and font sizes) never reaches the clipboard.
 */
export function writeSelectionClipboard(
  clipboardData: DataTransfer,
  container: Element,
): boolean {
  const selection = container.ownerDocument.defaultView?.getSelection();
  if (!selection) {
    return false;
  }
  const ranges = selectionRangesWithin(selection, container);
  if (!ranges) {
    return false;
  }
  const payload = buildSelectionClipboardPayload(
    ranges,
    container.ownerDocument,
  );
  // A selection of nothing but prunable content (a rendered diagram on its
  // own, a message's controls) renders to nothing. Writing that would empty
  // the clipboard, which is worse than whatever the browser would have put
  // there, so the copy is left alone.
  if (payload.html === "" && payload.text === "") {
    return false;
  }
  clipboardData.setData("text/html", payload.html);
  clipboardData.setData("text/plain", payload.text);
  return true;
}

export interface SelectionClipboardPayload {
  html: string;
  text: string;
}

/**
 * True when `fragment` holds nothing a reader would miss. Chrome and embedded
 * documents are pruned first: a drag that overshoots onto a message's
 * timestamp, or across a rendered diagram, has picked up nothing the clipboard
 * could have carried anyway.
 */
function isBlankFragment(fragment: DocumentFragment): boolean {
  pruneChrome(fragment);
  return (
    fragment.textContent?.trim() === "" &&
    fragment.querySelector(VOID_CONTENT_TAGS) === null
  );
}

/**
 * The parts of `selection` that lie inside `container`, or `null` when the
 * selection also covers content outside it.
 *
 * A boundary node outside `container` does not by itself mean the reader
 * selected anything outside: Chromium normalizes a drag that starts at the
 * left edge of a block, or above the first line, up to an ancestor element,
 * so a drag over one whole message commonly reports a start container that is
 * the message row rather than the message. Clamping to `container` and then
 * checking that the leftover parts hold no content keeps both cases right:
 * the whole-message drag is served, while a selection that genuinely reaches
 * other content is left to the browser rather than silently dropping the rest.
 */
export function selectionRangesWithin(
  selection: Selection,
  container: Node,
): Range[] | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const ownerDocument = container.ownerDocument;
  if (!ownerDocument) {
    return null;
  }
  const containerRange = ownerDocument.createRange();
  containerRange.selectNodeContents(container);

  const clampedRanges: Range[] = [];
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);

    const before = range.cloneRange();
    before.setEnd(containerRange.startContainer, containerRange.startOffset);
    const after = range.cloneRange();
    after.setStart(containerRange.endContainer, containerRange.endOffset);
    if (
      !isBlankFragment(before.cloneContents()) ||
      !isBlankFragment(after.cloneContents())
    ) {
      return null;
    }

    const clamped = range.cloneRange();
    if (
      clamped.compareBoundaryPoints(clamped.START_TO_START, containerRange) < 0
    ) {
      clamped.setStart(
        containerRange.startContainer,
        containerRange.startOffset,
      );
    }
    if (clamped.compareBoundaryPoints(clamped.END_TO_END, containerRange) > 0) {
      clamped.setEnd(containerRange.endContainer, containerRange.endOffset);
    }
    if (!clamped.collapsed) {
      clampedRanges.push(clamped);
    }
  }
  return clampedRanges.length > 0 ? clampedRanges : null;
}

function cloneRanges(
  ranges: readonly Range[],
  ownerDocument: Document,
): HTMLElement {
  const container = ownerDocument.createElement("div");
  for (const range of ranges) {
    container.appendChild(range.cloneContents());
  }
  pruneChrome(container);
  unwrapButtons(container);
  return container;
}

/**
 * Build clean `text/html` and markdown `text/plain` payloads for `ranges`.
 * Each flavor gets its own clone, since markdown reads the class names that
 * the HTML flavor strips. The live DOM is untouched.
 */
export function buildSelectionClipboardPayload(
  ranges: readonly Range[],
  ownerDocument: Document,
): SelectionClipboardPayload {
  const htmlRoot = cloneRanges(ranges, ownerDocument);
  stripAttributes(htmlRoot);
  const markdownRoot = cloneRanges(ranges, ownerDocument);
  return {
    html: htmlRoot.innerHTML,
    text: renderContainer(markdownRoot).trim(),
  };
}
