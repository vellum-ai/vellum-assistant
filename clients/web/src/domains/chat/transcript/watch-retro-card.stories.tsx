/**
 * The watch retrospective as the transcript draws it.
 *
 * The story exists to show the split the treatment is built on: the report
 * stays prose, and the two sections that are questions become panels of rows
 * with somewhere to put an answer. Answers stage into the quote-reply store,
 * which in the app surfaces them above the composer.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";

import { WatchRetroCard } from "@/domains/chat/transcript/watch-retro-card";
import { parseWatchRetro } from "@/domains/chat/transcript/watch-retro";

const RETRO = [
  "## 1. The task",
  "",
  "You were cleaning up your **Downloads** folder by removing disk image files (`.dmg`) you no longer need, moving them to Trash rather than deleting them outright.",
  "",
  "## 2. The phrase you would use to ask me to do this",
  "",
  '> "I have some DMGs in Downloads that I don\'t need anymore. Move them to the Trash."',
  "",
  "## 3. Steps",
  "",
  "1. Open Finder.",
  "2. Select **Downloads** from the sidebar.",
  "3. Sort by kind and find the `.dmg` files.",
  "4. Move the ones you no longer need to Trash.",
  "",
  "## 4. What I'm unsure about",
  "",
  "- Which specific DMG files should be considered safe to remove.",
  "- Whether Finder should open directly to Downloads every time, since one recorded screen showed **Recents**.",
  "- Whether anything outside Downloads is in scope.",
  "",
  "### Alignment pass",
  "",
  "Before I author or scaffold the skill, please confirm or correct these points:",
  "",
  "1. **Task:** Should the skill find unwanted `.dmg` files in Downloads and move the ones you approve to Trash?",
  "2. **Trigger phrases:** Are those the words you would use to ask for it?",
  "3. **Steps:** Is the order above right?",
].join("\n");

const meta: Meta<typeof WatchRetroCard> = {
  title: "Chat/WatchRetroCard",
  component: WatchRetroCard,
  parameters: { layout: "padded" },
  argTypes: { renderMarkdown: { control: false } },
  args: {
    segments: parseWatchRetro(RETRO) ?? [],
    messageId: "story-message",
    // The transcript injects its own markdown renderer; a plain block keeps
    // the story free of the chat's per-message wiring.
    renderMarkdown: (markdown: string) => (
      <div className="whitespace-pre-wrap text-[color:var(--content-default)]">
        {markdown}
      </div>
    ),
  },
};

export default meta;

type Story = StoryObj<typeof WatchRetroCard>;

export const Default: Story = {};
