import { describe, expect, test } from "bun:test";

import { renderTelegramHtml } from "./render.js";

// Expected values are derived from Telegram's documented Rich HTML vocabulary
// (https://core.telegram.org/bots/api#rich-html-style), not from the renderer's
// output. Notable doc-grounded choices:
//   - `<strong>`/`<em>`/`<del>` are listed as supported alongside `<b>`/`<i>`/
//     `<s>`, so the serializer's defaults need no remapping.
//   - Character references are numeric (`&#x26;`) because Telegram supports all
//     numeric references but only 13 named ones; numeric is unambiguously safe.
//   - `<img src>` is a supported tag, but only as a standalone media block, so
//     an image-only paragraph is unwrapped from its `<p>`.
describe("renderTelegramHtml", () => {
  test("returns undefined for empty or whitespace-only input", () => {
    expect(renderTelegramHtml("")).toBeUndefined();
    expect(renderTelegramHtml("   \n\t  ")).toBeUndefined();
  });

  test("wraps a plain paragraph", () => {
    expect(renderTelegramHtml("Hello world")).toBe("<p>Hello world</p>");
  });

  test("maps headings to h1-h6", () => {
    expect(renderTelegramHtml("# A")).toBe("<h1>A</h1>");
    expect(renderTelegramHtml("###### F")).toBe("<h6>F</h6>");
  });

  test("maps inline emphasis to Telegram's supported tags", () => {
    expect(renderTelegramHtml("**b** _i_ ~~d~~ `c`")).toBe(
      "<p><strong>b</strong> <em>i</em> <del>d</del> <code>c</code></p>",
    );
  });

  test("renders links with a numeric-escaped href", () => {
    expect(renderTelegramHtml("[text](https://x.test/?a=1&b=2)")).toBe(
      '<p><a href="https://x.test/?a=1&#x26;b=2">text</a></p>',
    );
  });

  test("renders fenced code with a language class and escaped body", () => {
    expect(renderTelegramHtml("```ts\nconst a = 1 < 2;\n```")).toBe(
      '<pre><code class="language-ts">const a = 1 &#x3C; 2;</code></pre>',
    );
  });

  test("renders a no-language code block as a bare pre", () => {
    expect(renderTelegramHtml("```\nplain\n```")).toBe("<pre>plain</pre>");
  });

  test("renders bullet and ordered lists", () => {
    expect(renderTelegramHtml("- one\n- two")).toBe(
      "<ul><li>one</li><li>two</li></ul>",
    );
    expect(renderTelegramHtml("3. a\n4. b")).toBe(
      '<ol start="3"><li>a</li><li>b</li></ol>',
    );
  });

  test("renders GFM task lists with bare checkbox inputs", () => {
    // Telegram's documented form is `<input type="checkbox" checked>` with no
    // `disabled` attribute and no list classes.
    expect(renderTelegramHtml("- [x] done\n- [ ] todo")).toBe(
      '<ul><li><input type="checkbox" checked>done</li>' +
        '<li><input type="checkbox">todo</li></ul>',
    );
  });

  test("renders a nested list inside a list item", () => {
    expect(renderTelegramHtml("- a\n  - b")).toBe(
      "<ul><li>a<ul><li>b</li></ul></li></ul>",
    );
  });

  test("renders a GFM table without thead/tbody wrappers", () => {
    const html = renderTelegramHtml("| H1 | H2 |\n| :- | -: |\n| a | b |");
    expect(html).toBe(
      "<table>" +
        '<tr><th align="left">H1</th><th align="right">H2</th></tr>' +
        '<tr><td align="left">a</td><td align="right">b</td></tr>' +
        "</table>",
    );
  });

  test("renders blockquotes, preserving paragraph structure", () => {
    expect(renderTelegramHtml("> quoted")).toBe(
      "<blockquote><p>quoted</p></blockquote>",
    );
    expect(renderTelegramHtml("> line one\n>\n> line two")).toBe(
      "<blockquote><p>line one</p><p>line two</p></blockquote>",
    );
  });

  test("renders a thematic break", () => {
    expect(renderTelegramHtml("---")).toBe("<hr>");
  });

  test("renders a standalone image as a top-level media block", () => {
    // Telegram accepts `<img>` only as a standalone media block, never nested
    // in a `<p>`, so the serializer's `<p><img></p>` wrapper is removed.
    expect(renderTelegramHtml("![alt text](https://x.test/i.png)")).toBe(
      '<img src="https://x.test/i.png" alt="alt text">',
    );
  });

  test("keeps an image inline when it shares a paragraph with text", () => {
    // A paragraph mixing prose and an image keeps its `<p>` so the surrounding
    // text is not orphaned; only image-only paragraphs are unwrapped.
    expect(renderTelegramHtml("see ![a](https://x.test/i.png) here")).toBe(
      '<p>see <img src="https://x.test/i.png" alt="a"> here</p>',
    );
  });

  test("preserves significant whitespace between inline elements in a list item", () => {
    // The space between adjacent inline nodes is content, not layout, so it must
    // survive: `Status: ready`, never `Status:ready`.
    expect(renderTelegramHtml("- **Status:** _ready_")).toBe(
      "<ul><li><strong>Status:</strong> <em>ready</em></li></ul>",
    );
  });

  // Fidelity: characters that Telegram's Rich *Markdown* dialect reinterprets
  // ($ math, == highlight, || spoiler, < HTML) must survive as literal text in
  // HTML mode rather than triggering those extensions.
  test("keeps Telegram Rich-Markdown-only syntax literal", () => {
    expect(renderTelegramHtml("Pay $100 to $200")).toBe(
      "<p>Pay $100 to $200</p>",
    );
    expect(renderTelegramHtml("a ==hi== b")).toBe("<p>a ==hi== b</p>");
    expect(renderTelegramHtml("a ||spoiler|| b")).toBe(
      "<p>a ||spoiler|| b</p>",
    );
  });

  test("escapes raw HTML so it renders verbatim", () => {
    expect(renderTelegramHtml("a <b>not bold</b> z")).toBe(
      "<p>a &#x3C;b>not bold&#x3C;/b> z</p>",
    );
  });

  test("emits numeric references for the characters HTML must escape", () => {
    // Only `&` and `<` require escaping in element text; `>`, `"`, and `'` are
    // left literal. Escaped characters use numeric references.
    expect(renderTelegramHtml(`& < > " '`)).toBe(`<p>&#x26; &#x3C; > " '</p>`);
  });
});
