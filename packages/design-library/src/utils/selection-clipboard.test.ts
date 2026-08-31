import { afterAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

import {
  buildSelectionClipboardPayload,
  selectionRangesWithin,
  writeSelectionClipboard,
} from "./selection-clipboard";

const window = new Window();
const document = window.document as unknown as Document;

afterAll(() => {
  void window.close();
});

/**
 * Render `html` into a fresh root, select `target` (a CSS selector, default
 * the whole root), and return the root plus the live selection.
 */
function selectIn(html: string, target?: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  const selection = document.getSelection();
  if (!selection) {
    throw new Error("no selection");
  }
  selection.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(
    target ? (root.querySelector(target) ?? root) : root,
  );
  selection.addRange(range);
  return { root, selection };
}

function payloadFor(html: string, target?: string) {
  const { selection } = selectIn(html, target);
  return buildSelectionClipboardPayload([selection.getRangeAt(0)], document);
}

describe("html flavor", () => {
  test("keeps semantic tags and drops classes, styles, and data attributes", () => {
    const { html } = payloadFor(
      '<p class="mb-3" data-x="1" style="background: grey"><strong class="font-bold">Hi</strong> <a class="link" href="https://example.com" target="_blank" rel="noopener">there</a></p>',
    );
    expect(html).toBe(
      '<p><strong>Hi</strong> <a href="https://example.com">there</a></p>',
    );
  });

  test("keeps the content of a button that is not a copy control", () => {
    const { html, text } = payloadFor(
      '<p>Open <button type="button" class="chip"><code>src/app.ts</code></button> now.</p>',
    );
    expect(html).toBe("<p>Open <code>src/app.ts</code> now.</p>");
    expect(text).toBe("Open `src/app.ts` now.");
  });

  test("strips the code block header row and its grey wrapper", () => {
    const { html } = payloadFor(
      '<div class="bg-stone-100"><div data-code-block-header=""><span>sql</span><button data-copy-control="">Copy</button></div><pre class="p-3" style="max-height: 400px"><code class="language-sql">SELECT 1</code></pre></div>',
    );
    expect(html).not.toContain("<button");
    expect(html).not.toContain("class=");
    expect(html).not.toContain("style=");
    expect(html).not.toContain("sql</span>");
    expect(html).toContain("<pre><code>SELECT 1</code></pre>");
  });

  test("keeps ordered list start, pinned item ordinals, and image src/alt", () => {
    const { html } = payloadFor(
      '<ol start="3" class="list"><li value="4">a</li></ol><img src="x.png" alt="pic" class="w-4">',
    );
    expect(html).toBe(
      '<ol start="3"><li value="4">a</li></ol><img src="x.png" alt="pic">',
    );
  });

  test("keeps a task list checkbox a checkbox", () => {
    const { html } = payloadFor(
      '<ul><li class="task"><input type="checkbox" disabled="" checked=""> done</li></ul>',
    );
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
  });

  test("drops aria-hidden KaTeX duplicates", () => {
    const { html } = payloadFor(
      '<p><span class="katex"><span class="katex-mathml">x</span><span class="katex-html" aria-hidden="true">x</span></span></p>',
    );
    expect(html).not.toContain("aria-hidden");
    expect(html).toBe("<p><span><span>x</span></span></p>");
  });
});

describe("markdown flavor", () => {
  test("separates paragraphs by one blank line and list items by one newline", () => {
    const { text } = payloadFor(
      "<p>First.</p><p>Second.</p><ul><li>one</li><li>two</li></ul><p>Third.</p>",
    );
    expect(text).toBe("First.\n\nSecond.\n\n- one\n- two\n\nThird.");
  });

  test("renders headings with their level's hashes", () => {
    const { text } = payloadFor(
      "<h1>One</h1><p>body</p><h3>Three</h3><h6>Six</h6>",
    );
    expect(text).toBe("# One\n\nbody\n\n### Three\n\n###### Six");
  });

  test("renders bold, italic, strikethrough, links, and inline code", () => {
    const { text } = payloadFor(
      '<p><strong>bold</strong> and <em>italic</em> and <del>gone</del>, a <a href="https://example.com">link</a>, and <code class="rounded">useState()</code>.</p>',
    );
    expect(text).toBe(
      "**bold** and _italic_ and ~~gone~~, a [link](https://example.com), and `useState()`.",
    );
  });

  test("keeps emphasis markers tight against their content", () => {
    const { text } = payloadFor("<p>a <strong> bold </strong>b</p>");
    expect(text).toBe("a **bold** b");
  });

  test("switches the marker for emphasis nested in the same emphasis", () => {
    const { text } = payloadFor(
      "<p><em>italic <em>inner</em> tail</em> and <strong>bold <strong>inner</strong></strong></p>",
    );
    expect(text).toBe("_italic *inner* tail_ and **bold __inner__**");
  });

  test("renders task list items as GFM checkboxes", () => {
    const { text } = payloadFor(
      '<ul><li><input type="checkbox" disabled=""> open task</li><li><input type="checkbox" disabled="" checked=""> done task</li></ul>',
    );
    expect(text).toBe("- [ ] open task\n- [x] done task");
  });

  test("leaves an autolink unwrapped", () => {
    const { text } = payloadFor(
      '<p><a href="https://example.com">https://example.com</a></p>',
    );
    expect(text).toBe("https://example.com");
  });

  test("grows the inline code delimiter past backticks in the content", () => {
    const { text } = payloadFor("<p><code>a ` b</code></p>");
    expect(text).toBe("``a ` b``");
  });

  test("renders images as markdown", () => {
    const { text } = payloadFor('<p><img src="x.png" alt="a cat"></p>');
    expect(text).toBe("![a cat](x.png)");
  });

  test("numbers ordered lists from their start and honors pinned ordinals", () => {
    const { text } = payloadFor(
      '<ol start="4"><li>four</li><li>five</li><li value="9">nine</li></ol>',
    );
    expect(text).toBe("4. four\n5. five\n9. nine");
  });

  test("continues numbering from a pinned ordinal, not from the list start", () => {
    const { text } = payloadFor(
      '<ol><li>one</li><li>two</li><li value="4">four</li><li>five</li></ol>',
    );
    expect(text).toBe("1. one\n2. two\n4. four\n5. five");
  });

  test("indents a nested list under its parent item", () => {
    const { text } = payloadFor(
      "<ul><li>one<ul><li>nested</li><li>also nested</li></ul></li><li>two</li></ul>",
    );
    expect(text).toBe("- one\n  - nested\n  - also nested\n- two");
  });

  test("indents a list nested under an ordered item by the marker width", () => {
    const { text } = payloadFor(
      "<ol><li>first<ul><li>nested</li></ul></li></ol>",
    );
    expect(text).toBe("1. first\n   - nested");
  });

  test("prefixes every line of a blockquote, blank lines included", () => {
    const { text } = payloadFor(
      "<blockquote><div><p>First para.</p><p>Second para.</p></div></blockquote>",
    );
    expect(text).toBe("> First para.\n>\n> Second para.");
  });

  test("renders a code block as a fence with its language and indentation", () => {
    const { text } = payloadFor(
      '<p>Run:</p><div data-code-block-header=""><span>ts</span><button data-copy-control="">Copy</button></div><pre><code class="block font-mono language-ts">function f() {\n  return 1;\n}\n</code></pre>',
    );
    expect(text).toBe("Run:\n\n```ts\nfunction f() {\n  return 1;\n}\n```");
  });

  test("grows the fence past a backtick run inside the code", () => {
    const { text } = payloadFor("<pre><code>const fence = ```;</code></pre>");
    expect(text).toBe("````\nconst fence = ```;\n````");
  });

  test("renders tables as GFM pipes with a separator row", () => {
    const { text } = payloadFor(
      "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
    );
    expect(text).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  test("escapes pipes inside table cells", () => {
    const { text } = payloadFor(
      "<table><tr><th>Op</th></tr><tr><td><code>a | b</code></td></tr></table>",
    );
    expect(text).toBe("| Op |\n| --- |\n| `a \\| b` |");
  });

  test("renders a horizontal rule", () => {
    const { text } = payloadFor("<p>above</p><hr><p>below</p>");
    expect(text).toBe("above\n\n---\n\nbelow");
  });

  test("tolerates react-markdown's newline text nodes between blocks", () => {
    const { text } = payloadFor(
      "<p>Hello,</p>\n<p>Thanks for reaching out.</p>\n<p>Best,<br>Alice</p>",
    );
    expect(text).toBe("Hello,\n\nThanks for reaching out.\n\nBest,\nAlice");
  });

  test("collapses whitespace in prose", () => {
    const { text } = payloadFor("<p>a  b\n   c</p>");
    expect(text).toBe("a b c");
  });

  test("skips the copy button and aria-hidden KaTeX duplicates", () => {
    const { text } = payloadFor(
      '<p><span class="katex"><span class="katex-mathml">x</span><span class="katex-html" aria-hidden="true">x</span></span><button data-copy-control="">Copy</button></p>',
    );
    expect(text).toBe("x");
  });

  test("a partial selection within a paragraph copies only the selected text", () => {
    const { root, selection } = selectIn("<p>Hello wide world</p>");
    const textNode = root.querySelector("p")?.firstChild;
    if (!textNode) {
      throw new Error("no text node");
    }
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(textNode, 6);
    range.setEnd(textNode, 10);
    selection.addRange(range);
    const payload = buildSelectionClipboardPayload([range], document);
    expect(payload.text).toBe("wide");
    expect(payload.html).toBe("wide");
  });
});

describe("embedded documents", () => {
  test("drops an embedded frame and the wrappers it leaves empty", () => {
    const { html, text } = payloadFor(
      '<div><div><iframe src="about:blank"></iframe></div></div><p>After</p>',
    );
    expect(html).toBe("<p>After</p>");
    expect(text).toBe("After");
  });

  test("keeps a wrapper that still holds an image", () => {
    const { html } = payloadFor(
      '<div><img src="https://example.com/a.png" alt="A"></div><p>After</p>',
    );
    expect(html).toBe(
      '<div><img src="https://example.com/a.png" alt="A"></div><p>After</p>',
    );
  });

  test("keeps an empty table cell, which is part of the shape", () => {
    const { html } = payloadFor(
      "<table><tbody><tr><td>a</td><td></td></tr></tbody></table>",
    );
    expect(html).toContain("<td></td>");
  });
});

describe("writeSelectionClipboard", () => {
  /** Minimal stand-in for the event's `DataTransfer`. */
  function fakeClipboardData() {
    const written: Record<string, string> = {};
    return {
      written,
      transfer: {
        setData: (type: string, value: string) => {
          written[type] = value;
        },
      } as unknown as DataTransfer,
    };
  }

  test("writes both flavors for a selection of real content", () => {
    const { root } = selectIn("<p>Hello</p>");
    const { written, transfer } = fakeClipboardData();
    expect(writeSelectionClipboard(transfer, root)).toBe(true);
    expect(written["text/html"]).toBe("<p>Hello</p>");
    expect(written["text/plain"]).toBe("Hello");
  });

  /**
   * Emptying the clipboard is worse than whatever the browser would have put
   * there, so a selection that renders to nothing is left to the browser.
   */
  test("declines a selection holding only prunable content", () => {
    const { root } = selectIn('<div><iframe src="about:blank"></iframe></div>');
    const { written, transfer } = fakeClipboardData();
    expect(writeSelectionClipboard(transfer, root)).toBe(false);
    expect(written).toEqual({});
  });
});

describe("selectionRangesWithin", () => {
  test("returns the selection when it is entirely inside the container", () => {
    const { root, selection } = selectIn("<p>a</p><p>b</p>", "p:last-child");
    const ranges = selectionRangesWithin(selection, root);
    expect(ranges?.map((range) => range.toString())).toEqual(["b"]);
  });

  test("returns null for a collapsed selection", () => {
    const { root, selection } = selectIn("<p>a</p>");
    selection.collapseToStart();
    expect(selectionRangesWithin(selection, root)).toBeNull();
  });

  test("returns null when the selection covers content outside the container", () => {
    const { root, selection } = selectIn("<p>a</p>");
    const outside = document.createElement("p");
    outside.textContent = "outside";
    document.body.appendChild(outside);
    selection.getRangeAt(0).setEnd(outside.firstChild as Node, 3);
    expect(selectionRangesWithin(selection, root)).toBeNull();
  });

  /**
   * The whole-message drag: Chromium reports an ancestor of the container as
   * the start node, but nothing outside the container is actually selected.
   */
  test("clamps a boundary that sits outside but selects nothing outside", () => {
    const wrapper = document.createElement("div");
    const root = document.createElement("div");
    root.innerHTML = "<p>inside</p>";
    wrapper.appendChild(root);
    document.body.appendChild(wrapper);
    const selection = document.getSelection();
    if (!selection) {
      throw new Error("no selection");
    }
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(wrapper, 0);
    range.setEnd(root.querySelector("p")?.firstChild as Node, 6);
    selection.addRange(range);
    const ranges = selectionRangesWithin(selection, root);
    expect(ranges?.map((entry) => entry.toString())).toEqual(["inside"]);
    expect(buildSelectionClipboardPayload(ranges ?? [], document).html).toBe(
      "<p>inside</p>",
    );
  });

  test("returns null when the part outside the container holds an image", () => {
    const wrapper = document.createElement("div");
    const image = document.createElement("img");
    image.setAttribute("src", "https://example.com/a.png");
    const root = document.createElement("div");
    root.innerHTML = "<p>inside</p>";
    wrapper.append(image, root);
    document.body.appendChild(wrapper);
    const selection = document.getSelection();
    if (!selection) {
      throw new Error("no selection");
    }
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(wrapper, 0);
    range.setEnd(root.querySelector("p")?.firstChild as Node, 6);
    selection.addRange(range);
    expect(selectionRangesWithin(selection, root)).toBeNull();
  });
});
