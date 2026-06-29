import { describe, expect, test } from "bun:test";

import { renderTelegramHtml } from "./render.js";

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
      "<p><b>b</b> <i>i</i> <s>d</s> <code>c</code></p>",
    );
  });

  test("renders links with an escaped href", () => {
    expect(renderTelegramHtml("[text](https://x.test/?a=1&b=2)")).toBe(
      '<p><a href="https://x.test/?a=1&amp;b=2">text</a></p>',
    );
  });

  test("renders fenced code with a language class and escaped body", () => {
    expect(renderTelegramHtml("```ts\nconst a = 1 < 2;\n```")).toBe(
      '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>',
    );
  });

  test("renders a fenceless/no-language code block as bare pre", () => {
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

  test("renders GFM task lists with checkbox inputs", () => {
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

  test("renders blockquotes", () => {
    expect(renderTelegramHtml("> quoted")).toBe(
      "<blockquote>quoted</blockquote>",
    );
  });

  test("renders a thematic break", () => {
    expect(renderTelegramHtml("---")).toBe("<hr/>");
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
      "<p>a &lt;b&gt;not bold&lt;/b&gt; z</p>",
    );
  });

  test("escapes the five reserved characters in text", () => {
    expect(renderTelegramHtml(`& < > " '`)).toBe(
      "<p>&amp; &lt; &gt; &quot; &apos;</p>",
    );
  });

  test("degrades an inline image to its alt text", () => {
    expect(renderTelegramHtml("![alt text](https://x.test/i.png)")).toBe(
      "<p>alt text</p>",
    );
  });
});
