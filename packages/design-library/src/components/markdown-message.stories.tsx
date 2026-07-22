import type { Meta, StoryObj } from "@storybook/react-vite";

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
      "Anthropic raised $65B — set `price=\"$5\"` in the config.",
      "",
      "```sh",
      'echo "$5 and $1,000"',
      "```",
      "",
      "See the [pricing page](https://example.com/p?amount=$5).",
    ].join("\n"),
  },
};
