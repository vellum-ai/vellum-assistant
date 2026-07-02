/**
 * Tests for the design-library MarkdownMessage component.
 *
 * Renders to static markup via `react-dom/server` and asserts on the
 * resulting HTML — no DOM testing library required.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MarkdownMessage } from "./markdown-message";

describe("MarkdownMessage", () => {
  test("root wrapper carries the chat typography token and data-slot", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, { content: "**Hi**" }),
    );

    expect(html).toContain("text-chat");
    expect(html).toContain("text-[var(--content-default)]");
    expect(html).toContain('data-slot="markdown-message"');
    expect(html).toContain("Hi");
  });

  test("heading overrides use the title + body typography scale", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "# H1\n\n## H2\n\n### H3",
      }),
    );

    expect(html).toContain("text-title-medium");
    expect(html).toContain("text-title-small");
    expect(html).toContain("text-body-medium-default");
  });

  test("blockquotes render with default markdown quote styling", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "> This is quoted.\n\nReply text.",
      }),
    );

    expect(html).toContain("italic");
    expect(html).toContain("text-stone-600");
    expect(html).not.toContain("rounded-md");
    expect(html).not.toContain("bg-[var(--surface-sunken)]");
  });

  test("quotePreview blockquotes render as compact quote previews", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "> This is quoted.\n\nReply text.",
        blockquoteVariant: "quotePreview",
      }),
    );

    expect(html).toContain("rounded-md");
    expect(html).toContain("bg-[var(--surface-sunken)]");
    expect(html).not.toContain(" italic ");
  });

  test("ordered list beginning at a non-1 number preserves its start", () => {
    // A terse "3." answer is parsed as a one-item ordered list starting at 3.
    // Without forwarding `start`, the <ol> defaults to 1 and renders "1.".
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, { content: "3." }),
    );

    expect(html).toContain('<ol start="3"');
  });

  test("ordered list starting at 1 omits a redundant start attribute", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, { content: "1. first\n2. second" }),
    );

    expect(html).toContain("<ol");
    expect(html).not.toContain("start=");
    // A contiguous list matches the auto-increment, so no item is pinned.
    expect(html).not.toContain("value=");
  });

  test("ordered list with a skipped number renders the typed ordinals", () => {
    // Replying to points 1, 2, 4, 5 (deliberately skipping 3) must not silently
    // renumber to 1, 2, 3, 4. CommonMark drops the markers, so item 4 is pinned
    // with <li value="4">; item 5 then follows naturally and needs no pin.
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "1. a\n2. b\n4. c\n5. d",
      }),
    );

    expect(html).toContain('<li value="4"');
    expect(html).not.toContain('value="3"');
  });

  test("ordered list that restarts mid-stream pins the lower number", () => {
    // 1, 2, then a fresh 1 — the restart drops below the running count, so the
    // third item is pinned back to <li value="1">.
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "1. a\n2. b\n1. c",
      }),
    );

    expect(html).toContain('<li value="1"');
  });

  test("tables render with the body-small typography token", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "| a | b |\n| - | - |\n| 1 | 2 |",
      }),
    );

    expect(html).toContain("text-body-small-default");
  });

  test("inline code in table cells wraps with preserved spacing and breathing room", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "| Function | Usage |\n| --- | --- |\n| `useState` | `const [s, setS] = useState(v)` |",
      }),
    );

    // Both <td> and <th> let inline code wrap while preserving its spacing.
    // leading-relaxed is load-bearing: the body-small token sets line-height:1,
    // which clips the padded inline-code background once it wraps onto a second
    // line.
    const tdMatches = html.match(/<td\b[^>]*class="([^"]*)"/g) ?? [];
    const thMatches = html.match(/<th\b[^>]*class="([^"]*)"/g) ?? [];
    for (const match of [...tdMatches, ...thMatches]) {
      expect(match).toContain("whitespace-pre-wrap");
      expect(match).toContain("leading-relaxed");
    }
    // Code elements inside cells are still inline code (not block).
    expect(html).toContain("<code");
  });

  test("forwards a supplied className onto the wrapper", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "hello",
        className: "custom-wrapper-class",
      }),
    );

    expect(html).toContain("custom-wrapper-class");
    expect(html).toContain("text-chat");
  });

  test("default links include noopener noreferrer", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "[Docs](https://example.com/docs)",
      }),
    );

    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("hardLineBreaks converts single newlines to <br> tags", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "line1\nline2\n\nline3\nline4",
        hardLineBreaks: true,
      }),
    );

    expect(html).toContain("line1<br/>");
    expect(html).toContain("line3<br/>");
    expect(html).toContain("</p>");
  });

  test("without hardLineBreaks, single newlines collapse", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "line1\nline2",
      }),
    );

    expect(html).not.toContain("<br");
    expect(html).toContain("line1");
    expect(html).toContain("line2");
  });

  test("hardLineBreaks leaves fenced code blocks verbatim (no trailing-space injection)", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "```js\nconst a = 1\nconst b = 2\n```",
        hardLineBreaks: true,
      }),
    );

    // The newline inside the code block must stay a bare newline — a blind
    // string replace would harden it into "  \n", corrupting the code with
    // trailing whitespace and/or a <br>.
    expect(html).toContain("const a = 1\nconst b = 2");
    expect(html).not.toContain("const a = 1  \n");
    expect(html.match(/<code[\s\S]*?<\/code>/)?.[0]).not.toContain("<br");
  });

  test("hardLineBreaks does not break table parsing", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "| a | b |\n| - | - |\n| 1 | 2 |",
        hardLineBreaks: true,
      }),
    );

    // Row-separating newlines are structural, not prose text nodes, so the
    // table still parses instead of collapsing into a <br>-laden paragraph.
    expect(html).toContain("<table");
    expect(html).not.toContain("<br");
  });

  test("h4-h6 render with bold typography instead of unstyled defaults", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "#### H4\n\n##### H5\n\n###### H6",
      }),
    );

    expect(html).toContain("<h4");
    expect(html).toContain("<h5");
    expect(html).toContain("<h6");
    // Every heading override restores bold weight on a canonical size token.
    expect(html.match(/<h4[^>]*>/)?.[0]).toContain("!font-bold");
    expect(html.match(/<h6[^>]*>/)?.[0]).toContain("!font-bold");
  });

  test("monetary text is not mangled into math typography", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "Anthropic raised a $65B series H at $965B post-money.",
      }),
    );

    // The currency dollars are escaped, so KaTeX never runs and the literal
    // amounts survive verbatim.
    expect(html).not.toContain("katex");
    expect(html).toContain("$65B");
    expect(html).toContain("$965B");
  });

  test("assorted currency formats survive as literal text", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "Pay $5, then $1,000.50, up to $1.5T or $100 billion.",
      }),
    );

    expect(html).not.toContain("katex");
    expect(html).toContain("$5");
    expect(html).toContain("$1,000.50");
    expect(html).toContain("$1.5T");
    expect(html).toContain("$100");
  });

  test("currency ranges with en/em dashes are not mangled into math", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "Savings are closer to $12K–$17K, maybe $1M—$2M.",
      }),
    );

    // The dash between the amounts must not let the first `$` open a math
    // span that closes on the next `$` (the italic-math wonk).
    expect(html).not.toContain("katex");
    expect(html).toContain("$12K");
    expect(html).toContain("$17K");
    expect(html).toContain("$1M");
    expect(html).toContain("$2M");
  });

  test("suffixed amounts with a trailing + are not mangled into math", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "Whitestone is premium - $1M+ homes earning $500K+ a year.",
      }),
    );

    // "$1M+" must not open a math span that closes on the next "$".
    expect(html).not.toContain("katex");
    expect(html).toContain("$1M+");
    expect(html).toContain("$500K+");
  });

  test("legitimate inline math still renders via KaTeX", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "The identity $E = mc^2$ and $2x + 1$ are math.",
      }),
    );

    expect(html).toContain("katex");
  });

  test("currency and real math coexist in one message", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "It costs $5 but $E = mc^2$ still holds.",
      }),
    );

    expect(html).toContain("katex");
    expect(html).toContain("$5");
  });

  test("currency inside inline code stays verbatim (no escape leaks)", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: 'Set `price="$5"` in the config.',
      }),
    );

    // The code span must be byte-exact — no stray backslash from escaping.
    // (Static markup HTML-encodes the quotes as &quot;.)
    expect(html).toContain("price=&quot;$5&quot;");
    expect(html).not.toContain("\\$");
  });

  test("currency inside a fenced code block stays verbatim", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: '```sh\necho "$5"\necho "$1,000"\n```',
      }),
    );

    expect(html).toContain("$5");
    expect(html).toContain("$1,000");
    expect(html).not.toContain("\\$");
  });

  test("currency inside a link destination is not rewritten", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "[pay](https://example.com/checkout?amount=$5)",
      }),
    );

    expect(html).toContain("amount=$5");
    expect(html).not.toContain("\\$");
  });

  test("currency in prose is still escaped even when code is present", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: 'It cost $65B total — run `echo "$5"` to verify.',
      }),
    );

    // Prose currency renders as plain text (no math), code stays exact.
    expect(html).not.toContain("katex");
    expect(html).toContain("$65B");
    expect(html).toContain("echo &quot;$5&quot;");
    expect(html).not.toContain("\\$");
  });

  test("custom linkComponent replaces the default link renderer", () => {
    function CustomLink({ href, children }: { href?: string; children?: React.ReactNode }) {
      return <a href={href} data-custom="true">{children}</a>;
    }

    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "[Link](https://example.com)",
        linkComponent: CustomLink,
      }),
    );

    expect(html).toContain('data-custom="true"');
    expect(html).not.toContain('rel="noopener noreferrer"');
  });

  test("emoji inside markdown italic renders upright, not skewed", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, { content: "*🥺*" }),
    );

    // The emoji is wrapped in a font-style:normal span inside the <em>, so the
    // browser's synthetic italic skew never reaches the emoji glyph.
    const em = html.match(/<em>[\s\S]*?<\/em>/)?.[0] ?? "";
    expect(em).toContain("🥺");
    expect(em).toContain("font-style:normal");
  });

  test("plain text emphasis is left byte-identical (no upright span)", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, { content: "*please*" }),
    );

    expect(html).toContain("<em>please</em>");
    expect(html).not.toContain("font-style:normal");
  });

  test("mixed emphasis keeps words italic and only the emoji upright", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, { content: "*so cute 🥺 really*" }),
    );

    const em = html.match(/<em>[\s\S]*?<\/em>/)?.[0] ?? "";
    // Words stay as plain italic text; only the emoji grapheme gets wrapped.
    expect(em).toContain("so cute ");
    expect(em).toContain(" really");
    expect(em).toContain('<span style="font-style:normal">🥺</span>');
  });

  test("VS15 text-presentation sequence stays italic", () => {
    // U+231A WATCH + U+FE0E (VS15) explicitly requests text presentation, so it
    // must keep italic obliqueness — mirrors the macOS rendersAsEmoji rule.
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, { content: "*⌚︎*" }),
    );

    expect(html).toContain("<em>");
    expect(html).not.toContain("font-style:normal");
  });
});
