/**
 * The one way a markdown file is shown: formatted, with its source one click
 * away. Every file surface goes through this, so the choice reads the same
 * and is called the same thing wherever you meet it.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent } from "storybook/test";

import { MarkdownView } from "./markdown-view";

const NOTE = [
  "---",
  "title: Release triage",
  "owner: platform",
  "---",
  "",
  "# Release triage",
  "",
  "Check the release label first, then group the failures by owning team.",
  "",
  "## Grouping",
  "",
  "One failure often spans three teams, so group by the team that owns the",
  "code rather than by the file it failed in.",
  "",
  "| Signal | Where it comes from |",
  "| --- | --- |",
  "| Label | The release issue |",
  "| Owner | The code owners file |",
].join("\n");

const meta: Meta<typeof MarkdownView> = {
  title: "Components/MarkdownView",
  component: MarkdownView,
  args: { content: NOTE },
};

export default meta;
type Story = StoryObj<typeof MarkdownView>;

/**
 * How a file opens. The leading YAML block is the file's metadata, not its
 * first paragraph, so the formatted view leaves it out.
 */
export const Formatted: Story = {
  play: async () => {
    await expect(screen.queryByText(/owner: platform/)).toBeNull();
  },
};

/** The same file's source, one click away, frontmatter and all. */
export const Source: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole("radio", { name: "Source" }));
    await expect(await screen.findByText(/owner: platform/)).toBeTruthy();
  },
};

/**
 * In a bounded pane, which is how a file surface hands it a box: the skills
 * tab on mobile gives it a card that is `overflow-hidden` with a height of
 * its own and no flex of its own. The view has to fill that box and scroll
 * inside it, in either mode, rather than growing past the bottom edge.
 */
export const InABoundedPane: Story = {
  args: {
    content: [
      NOTE,
      ...Array.from(
        { length: 12 },
        (_, i) =>
          `Paragraph ${i + 1} of a file longer than the pane that shows it.`,
      ),
    ].join("\n\n"),
  },
  render: (args) => (
    <div className="flex h-80 flex-col overflow-hidden rounded-xl border border-[var(--border-base)]">
      <div className="min-h-0 flex-1 overflow-hidden">
        <MarkdownView {...args} />
      </div>
    </div>
  ),
};
