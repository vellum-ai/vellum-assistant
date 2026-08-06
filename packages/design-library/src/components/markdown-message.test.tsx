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

  test("blockquotes render as universal inset quote blocks", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "> This is quoted.\n\nReply text.",
      }),
    );

    expect(html).toContain("rounded-md");
    expect(html).toContain("bg-[var(--surface-sunken)]");
    expect(html).toContain("mx-0");
    expect(html).toContain("flex");
    expect(html).toContain("gap-3");
    // The accent bar stretches with the quote so multi-line quotes get a
    // full-height rule, not a fixed-height pill floating mid-quote.
    expect(html).toContain("self-stretch");
    expect(html).not.toContain("h-5");
    expect(html).toContain("w-0.5");
    expect(html).toContain("rounded-full");
    expect(html).toContain("min-w-0");
    expect(html).toContain("flex-1");
    expect(html).toContain("text-[var(--content-secondary)]");
    expect(html).not.toContain("text-stone-600");
    expect(html).not.toContain("italic");
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

  test("tables render with the small prose typography token", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "| a | b |\n| - | - |\n| 1 | 2 |",
      }),
    );

    // The prose token (real leading), not the single-line label token —
    // cell content wraps, and the label token's line-height:1 collapses
    // wrapped lines onto each other.
    expect(html).toContain("text-body-small-lighter");
    expect(html).not.toContain("text-body-small-default");
  });

  test("inline code in table cells wraps with preserved spacing and breathing room", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content:
          "| Function | Usage |\n| --- | --- |\n| `useState` | `const [s, setS] = useState(v)` |",
      }),
    );

    // Both <td> and <th> let inline code wrap while preserving its spacing.
    const tdMatches = html.match(/<td\b[^>]*class="([^"]*)"/g) ?? [];
    const thMatches = html.match(/<th\b[^>]*class="([^"]*)"/g) ?? [];
    for (const match of [...tdMatches, ...thMatches]) {
      expect(match).toContain("whitespace-pre-wrap");
    }
    // Code elements inside cells are still inline code (not block), and carry
    // the small prose token so the padded chip background stays inside its
    // own line box once it wraps in a cell.
    const cellCodeTag = html.match(/<code[^>]*>/)?.[0] ?? "";
    expect(cellCodeTag).toContain("text-body-small-lighter");
  });

  test("inline code and blockquotes use the small prose token so chips never overlap prose", () => {
    // The body-small *label* token bakes line-height:1 into its utility. A
    // quote's wrapped prose would get 12px line boxes while a padded
    // inline-code chip paints ~18px tall — chips from one line would cover
    // the lines above and below. Both the quote block and the chip must use
    // the small *prose* token (real leading) instead.
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "> Set `backup.enabled` to `false` in the config file.",
      }),
    );

    const blockquoteTag = html.match(/<blockquote[^>]*>/)?.[0] ?? "";
    expect(blockquoteTag).toContain("text-body-small-lighter");
    expect(blockquoteTag).not.toContain("text-body-small-default");

    const codeTag = html.match(/<code[^>]*>/)?.[0] ?? "";
    expect(codeTag).toContain("text-body-small-lighter");
    expect(codeTag).not.toContain("text-body-small-default");
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

  test("fenced code renders a single scroll container — pre scrolls, code does not", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "```sql\nSELECT 1;\n```",
      }),
    );

    const preTag = html.match(/<pre[^>]*>/)?.[0] ?? "";
    const codeTag = html.match(/<code[^>]*>/)?.[0] ?? "";

    expect(preTag).toContain("overflow-auto");
    expect(preTag).toContain("max-height:400px");
    expect(codeTag).toContain("w-max");
    expect(codeTag).toContain("min-w-full");
    expect(codeTag).not.toContain("overflow-");
  });

  test("inline code renders a chip with no scroll container", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, { content: "an `x` value" }),
    );

    const codeTag = html.match(/<code[^>]*>/)?.[0] ?? "";

    expect(codeTag).toContain("rounded bg-stone-100 px-1 py-0.5");
    expect(codeTag).not.toContain("overflow-");
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

  test("bare amounts with a trailing + are not mangled into math", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content:
          'the $50+ "always-present" tier funds the *launch* year — the tier at $10-15 is the *destination*.',
      }),
    );

    // "$50+" must not open a math span that closes on the escaped "$10-15",
    // which would leak the escape backslash and swallow the emphasis.
    expect(html).not.toContain("katex");
    expect(html).toContain("$50+");
    expect(html).toContain("$10-15");
    expect(html).toMatch(/<em[^>]*>launch<\/em>/);
    expect(html).toMatch(/<em[^>]*>destination<\/em>/);
    expect(html).not.toContain("\\$");
  });

  test("bare arithmetic with a + still renders as math", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "The sum $1+1$ is math.",
      }),
    );

    expect(html).toContain("katex");
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

  test("ChatGPT-style inline delimiters render as inline math", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "The identity \\(E = mc^2\\) still holds.",
      }),
    );

    expect(html).toContain("katex");
    // Inline math stays inline: no display-mode wrapper, no leaked delimiters.
    expect(html).not.toContain("katex-display");
    expect(html).not.toContain("\\(");
    expect(html).not.toContain("(E = mc^2)");
  });

  test("ChatGPT-style display delimiters render as display math", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "The area is:\n\n\\[\nA = \\pi r^2\n\\]\n\nas expected.",
      }),
    );

    expect(html).toContain("katex-display");
    expect(html).not.toContain("\\[");
  });

  test("display delimiters mid-sentence still typeset in display mode", () => {
    // remark-math only treats `$$` as a block when the fence opens a line, so a
    // `\[…\]` span inside a sentence has to be lifted out of its paragraph.
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "Given \\[\\sum_{i=1}^n i\\] we are done.",
      }),
    );

    expect(html).toContain("katex-display");
    expect(html).toContain("Given");
    expect(html).toContain("we are done.");
  });

  test("display math inside a list item stays inside the list", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "1. First compute \\[x = a + b\\]\n2. Then stop",
      }),
    );

    expect(html).toContain("katex-display");
    // The math is lifted to a block *within* the list item, not after the list.
    expect(html).toMatch(/<li[^>]*>[\s\S]*katex-display[\s\S]*<\/li>/);
    expect(html).toContain("Then stop");
  });

  test("both delimiter styles coexist in one message", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "With \\(a\\) and \\(b\\):\n\n\\[\nc = a + b\n\\]",
      }),
    );

    expect(html).toContain("katex-display");
    expect(html.match(/katex/g)?.length).toBeGreaterThan(2);
    expect(html).not.toContain("\\(");
    expect(html).not.toContain("\\[");
  });

  test("escaped delimiters inside code stay verbatim", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "Write `\\(x\\)` for inline math.\n\n```tex\n\\[x\\]\n```",
      }),
    );

    // Code is a verbatim region: no math runs and the source survives exactly.
    expect(html).not.toContain("katex");
    expect(html).toContain("\\(x\\)");
    expect(html).toContain("\\[x\\]");
  });

  test("an unpaired delimiter is left as literal text", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "An open \\[ bracket and a stray $ sign.",
      }),
    );

    // Converting the lone opener would let it pair with the unrelated `$`.
    expect(html).not.toContain("katex");
    expect(html).toContain("[ bracket");
  });

  test("a stray opener does not consume the equation that follows it", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "Prefix \\( literal; then \\(x = 1\\) here.",
      }),
    );

    // Pairing the stray opener with the real equation's closer would hand
    // KaTeX `\( literal; then \(x = 1` and lose the equation entirely.
    expect(html).toContain("katex");
    expect(html).not.toContain("katex-error");
    expect(html).toContain("Prefix ( literal; then ");
    expect(html).toContain("here.");
  });

  test("a stray display opener does not consume the equation that follows", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "Arrays \\[ literal; the identity \\[E = mc^2\\] holds.",
      }),
    );

    expect(html).toContain("katex-display");
    expect(html).not.toContain("katex-error");
    expect(html).toContain("Arrays [ literal; the identity");
    expect(html).toContain("holds.");
  });

  test("delimiters separated by a blank line are not paired into math", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "Arrays use \\[ here.\n\nAnd close \\] over there.",
      }),
    );

    expect(html).not.toContain("katex");
  });

  test("a delimiter pair straddling inline code is left alone", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "Use \\( the `code()` call \\) carefully.",
      }),
    );

    // Math tokenization would swallow the code span, so the pair is skipped.
    expect(html).not.toContain("katex");
    expect(html).toContain("<code");
  });

  test("display delimiters survive hard line breaks", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "Result:\n\\[\nE = mc^2\n\\]",
        hardLineBreaks: true,
      }),
    );

    expect(html).toContain("katex-display");
    expect(html).not.toContain("\\[");
  });

  test("currency is not mangled by delimiter conversion", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "It costs $5, and \\(x = 5\\) is the count.",
      }),
    );

    expect(html).toContain("$5");
    expect(html).toContain("katex");
    expect(html).not.toContain("\\$");
  });

  test("custom linkComponent replaces the default link renderer", () => {
    function CustomLink({
      href,
      children,
    }: {
      href?: string;
      children?: React.ReactNode;
    }) {
      return (
        <a href={href} data-custom="true">
          {children}
        </a>
      );
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

  test("custom imageComponent receives absolute host paths", () => {
    const seen: { src: string; alt: string }[] = [];
    function CustomImage({ src, alt }: { src: string; alt: string }) {
      seen.push({ src, alt });
      return <span data-custom-image={src}>{alt}</span>;
    }

    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "![chart](/Users/alice/files/chart.png)",
        imageComponent: CustomImage,
      }),
    );

    expect(seen).toEqual([
      { src: "/Users/alice/files/chart.png", alt: "chart" },
    ]);
    expect(html).toContain('data-custom-image="/Users/alice/files/chart.png"');
    expect(html).not.toContain("<img");
  });

  test("custom imageComponent receives data: srcs", () => {
    const seen: string[] = [];
    function CustomImage({ src, alt }: { src: string; alt: string }) {
      seen.push(src);
      return <span data-custom-image="true">{alt}</span>;
    }

    const dataUri = "data:image/png;base64,iVBORw0KGgo=";
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: `![inline](${dataUri})`,
        imageComponent: CustomImage,
        // react-markdown's default sanitizer rejects `data:`, so the consumer's
        // transform is what lets the payload through to the component.
        urlTransform: (url: string) => url,
      }),
    );

    expect(seen).toEqual([dataUri]);
    expect(html).toContain('data-custom-image="true"');
    expect(html).not.toContain("<img");
  });

  test("custom imageComponent receives srcs the url transform rejected", () => {
    const seen: string[] = [];
    function CustomImage({ src, alt }: { src: string; alt: string }) {
      seen.push(src);
      return <span data-custom-image="true">{alt}</span>;
    }

    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        // The default sanitizer blanks the `data:` src, and the empty result
        // still belongs to the consumer's component, not a bare <img>.
        content: "![inline](data:image/png;base64,iVBORw0KGgo=)",
        imageComponent: CustomImage,
      }),
    );

    expect(seen).toEqual([""]);
    expect(html).not.toContain("<img");
  });

  test("without an imageComponent local srcs render a bare img", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content:
          "![chart](/Users/alice/files/chart.png)\n\n![thumb](./thumb.png)",
      }),
    );

    expect(html).toContain(
      '<img src="/Users/alice/files/chart.png" alt="chart"',
    );
    expect(html).toContain('<img src="./thumb.png" alt="thumb"');
    expect(html).toContain("my-1 max-w-full rounded");
  });

  test("without an imageComponent remote srcs show the blocked placeholder", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "![blocked](https://example.com/blocked.png)",
      }),
    );

    expect(html).toContain("External image not rendered");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("https://example.com/blocked.png");
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
