import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";

import { MarkdownMessage } from "./markdown-message";

const meta: Meta<typeof MarkdownMessage> = {
  title: "Components/MarkdownMessage",
  component: MarkdownMessage,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 560 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof MarkdownMessage>;

export const Default: Story = {
  args: {
    content:
      "# Heading\n\nSome **bold** and _italic_ text with a [link](https://example.com).\n\n- one\n- two\n\n> a blockquote",
  },
};

/**
 * Regression guard for LUM-2788: prose mixed with inline code chips inside a
 * blockquote must keep real leading — a line-height:1 label token on the
 * quote lets the chips' padded backgrounds paint over adjacent lines.
 */
export const QuoteWithInlineCode: Story = {
  args: {
    content: [
      "> Symptom: Settings shows `backup.enabled` as `false` in config, and",
      "> `handleBackupCreate()` throws a `BadRequestError` saying creation",
      "> moved to the gateway (`POST /v1/backups/create`). Three `.vbundle`",
      "> files exist in `~/.vellum/backups/local/` — nothing newer.",
    ].join("\n"),
  },
};

/** A fenced block that overflows both axes. */
export const LongCodeBlock: Story = {
  args: {
    content: [
      "```sql",
      ...Array.from(
        { length: 40 },
        (_, i) =>
          `SELECT column_${i}, another_long_column_name_${i}, yet_another_column_${i} FROM analytics_events_table WHERE tenant_id = ${i};`,
      ),
      "```",
    ].join("\n"),
  },
};

/**
 * Every markdown feature the component styles, in one story — the visual-QA
 * sweep target. Each block exercises a dedicated component override (heading
 * levels, lists with pinned ordinals, quote with inline code, table with
 * wrapping code, fenced code, hr, emphasis with emoji, image fallback), so a
 * regression in any of them is visible here without hunting per-feature
 * stories.
 */
export const KitchenSink: Story = {
  args: {
    content: [
      "# Heading one",
      "## Heading two",
      "### Heading three",
      "#### Heading four",
      "##### Heading five",
      "###### Heading six",
      "",
      "Prose with **bold**, _italic *🎉* emoji_, ~~strikethrough~~, a [link](https://example.com), and inline `code.chips` mixed into the sentence flow across `multiple` tokens.",
      "",
      "- bullet one",
      "- bullet two",
      "  - nested bullet",
      "",
      "1. first",
      "2. second",
      "4. fourth — typed ordinal is preserved",
      "",
      "- [ ] open task",
      "- [x] done task",
      "",
      "> Quote mixing prose with `inline.code` chips across lines —",
      "> `handleBackupCreate()` throws a `BadRequestError` here, and the",
      "> accent bar spans the quote's full height.",
      "",
      "| Function | Usage |",
      "| --- | --- |",
      "| `useState` | `const [s, setS] = useState(initialValue)` |",
      "| plain cell | prose that wraps onto a second line inside the cell |",
      "",
      "```ts",
      "const answer: number = 42;",
      "export function greet(name: string): string {",
      "  return `hello ${name}`;",
      "}",
      "```",
      "",
      "---",
      "",
      "![missing image](https://example.com/blocked.png)",
    ].join("\n"),
  },
};

/**
 * Regression guard for JARVIS-1006: monetary values must render as plain text
 * rather than being greedily paired into italic LaTeX math by remark-math.
 */
export const CurrencyText: Story = {
  args: {
    content:
      "Anthropic raised a $65B series H at $965B post-money. Tiers run $5, $1,000.50, $100M, and $1.5T — roughly $100 billion all-in. The $50+ tier funds the *launch* year; $10-15 is the *destination*.",
  },
};

/** Legitimate inline and block math is left untouched. */
export const Math: Story = {
  args: {
    content:
      "The identity $E = mc^2$ holds, and so does $2x + 1$.\n\n$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$",
  },
};

/**
 * ChatGPT-style math delimiters: `\(…\)` inline and `\[…\]` display, including
 * a display span typed mid-sentence and one inside a list item. Both render
 * identically to the `$`-delimited equivalents in the Math story.
 */
export const ChatGptMathDelimiters: Story = {
  args: {
    content: [
      "Mass and energy relate by \\(E = mc^2\\), so the total is:",
      "",
      "\\[",
      "E_{\\text{total}} = \\sum_{i=1}^{n} m_i c^2",
      "\\]",
      "",
      "Substituting \\[\\int_0^1 x^2 \\, dx = \\frac{1}{3}\\] mid-sentence still typesets in display mode.",
      "",
      "1. Compute \\[a^2 + b^2 = c^2\\]",
      "2. Then take the square root",
    ].join("\n"),
  },
};

/** Currency and real equations coexisting in a single response. */
export const CurrencyAndMath: Story = {
  args: {
    content:
      "A widget costs $5 and the markup is $20M across the fleet, but the area formula $A = \\pi r^2$ still applies.",
  },
};

/**
 * Currency escaping must skip verbatim regions: the `$5` inside inline code,
 * the fenced block, and the link destination stay byte-exact, while the `$65B`
 * in prose is still rendered as plain text rather than math.
 */
export const CurrencyInCodeAndLinks: Story = {
  args: {
    content: [
      'Anthropic raised $65B, so set `price="$5"` in the config.',
      "",
      "```sh",
      'echo "$5 and $1,000"',
      "```",
      "",
      "See the [pricing page](https://example.com/p?amount=$5).",
    ].join("\n"),
  },
};

/**
 * A long document arriving as a stream, rendered with `incremental` so each
 * append re-parses only the block it lands in. Toggle the control off to
 * compare with whole-document parsing; the page should look identical, and
 * the difference is only in the work per append, which the browser's
 * performance panel makes visible on a document this long.
 *
 * Owns the streaming clock locally rather than through `useArgs`, so the
 * stream restarts whenever the content or the mode changes.
 */
export const IncrementalStreaming: Story = {
  args: {
    incremental: true,
    hardLineBreaks: true,
    content: Array.from({ length: 60 }, (_, i) =>
      [
        `## Step ${i + 1}`,
        "",
        `I should check the ${i + 1}th file next.`,
        `It costs $${i + 1} and the area is $A = \\pi r^2$, so the plan is:`,
        "",
        "- read the listing",
        "- compare against the last run",
        "",
        "```ts",
        `const step = ${i + 1};`,
        "",
        "export const done = step > 0;",
        "```",
        "",
        "> Keep the fence and the list together while they stream.",
        "",
      ].join("\n"),
    ).join("\n"),
  },
  argTypes: {
    incremental: { control: "boolean" },
  },
  render: function Render(args) {
    const [shown, setShown] = useState(0);
    useEffect(() => {
      setShown(0);
      // `Math` is the story of that name above, so the clamp is spelled out.
      const timer = setInterval(() => {
        setShown((n) =>
          n + 24 > args.content.length ? args.content.length : n + 24,
        );
      }, 16);
      return () => clearInterval(timer);
    }, [args.content, args.incremental]);
    return <MarkdownMessage {...args} content={args.content.slice(0, shown)} />;
  },
};

/**
 * File content: a README with the HTML a project uses for layout, a
 * frontmatter block the reader should never see, and a `$` that is a shell
 * variable rather than maths.
 */
export const Document: Story = {
  args: {
    parseHtml: true,
    remoteImages: true,
    math: false,
    frontmatter: "metadata",
    content: [
      "---",
      "title: Caveman",
      "sidebar_position: 3",
      "---",
      "",
      '<p align="center">',
      '  <img src="https://example.invalid/logo.png" width="120" alt="Logo" />',
      "</p>",
      "",
      "# Caveman",
      "",
      "A plugin that answers in as few words as it can.",
      "",
      "## Install",
      "",
      "Set `$CAVEMAN_HOME` and run the installer:",
      "",
      "```bash",
      "caveman install --prefix $CAVEMAN_HOME",
      "```",
      "",
      "## Options",
      "",
      "| Option | Default | What it does |",
      "| --- | --- | --- |",
      "| `grunts` | `2` | How many grunts per answer. |",
      "| `fire` | `off` | Whether to mention fire. |",
      "",
      "> Caveman does not explain. Caveman answers.",
      "",
      "1. Install it",
      "2. Ask it something",
      "3. Receive two words",
    ].join("\n"),
  },
};
