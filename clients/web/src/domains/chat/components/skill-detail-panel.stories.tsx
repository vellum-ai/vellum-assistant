import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  skillsByIdFilesContentGetQueryKey,
  skillsByIdFilesGetQueryKey,
  skillsByIdGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { type SeedQueryCache, withQueryCache } from "@/lib/story-query-cache";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import { DetailPanelStoryFrame } from "@/domains/chat/components/detail-panel-story-frame";

import { SkillDetailPanel } from "./skill-detail-panel";

/**
 * Both the skill and its SKILL.md content are seeded into a story-local
 * cache, so the panel renders with no network and no mocks, matching the
 * pattern in `intelligence/components/skills/skill-detail.stories.tsx`.
 */

const ASSISTANT_ID = "asst_story";
const SKILL_ID = "release-triage";

useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });

const SKILL_MD = `---
name: Release triage
description: Triage a release's failing checks.
---

# Release triage

Read the release label first.
Skip drafts unless the label is explicit.

## Grouping

Group the failures by owning team, not by file: one file often spans
three teams.
`;

function seedSkill(options: {
  emoji?: string;
  removable: boolean;
}): SeedQueryCache {
  return (client) => {
    const path = { assistant_id: ASSISTANT_ID, id: SKILL_ID };

    client.setQueryData(skillsByIdGetQueryKey({ path }), {
      skill: {
        id: SKILL_ID,
        name: "Release triage",
        description:
          "Check the release label, group failures by owning team, and post the summary in the release thread.",
        emoji: options.emoji,
        kind: options.removable ? "installed" : "bundled",
        status: "enabled",
        origin: options.removable ? "assistant-memory" : "bundled",
        category: "Engineering",
      },
    });
    client.setQueryData(skillsByIdFilesGetQueryKey({ path }), {
      files: [
        {
          name: "SKILL.md",
          path: "SKILL.md",
          size: SKILL_MD.length,
          mimeType: "text/markdown",
          isBinary: false,
        },
      ],
    });
    client.setQueryData(
      skillsByIdFilesContentGetQueryKey({ path, query: { path: "SKILL.md" } }),
      {
        path: "SKILL.md",
        name: "SKILL.md",
        size: SKILL_MD.length,
        mimeType: "text/markdown",
        isBinary: false,
        content: SKILL_MD,
      },
    );
  };
}

function withFrame(Story: () => React.ReactElement) {
  return (
    <DetailPanelStoryFrame>
      <Story />
    </DetailPanelStoryFrame>
  );
}

const meta: Meta<typeof SkillDetailPanel> = {
  title: "Chat/SkillDetailPanel",
  component: SkillDetailPanel,
  parameters: {
    layout: "fullscreen",
  },
  args: {
    skillId: SKILL_ID,
    onClose: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof SkillDetailPanel>;

export const Removable: Story = {
  decorators: [
    withFrame,
    withQueryCache(seedSkill({ emoji: "🚦", removable: true })),
  ],
};

export const Bundled: Story = {
  decorators: [
    withFrame,
    withQueryCache(seedSkill({ emoji: "🚦", removable: false })),
  ],
};

export const NoEmoji: Story = {
  decorators: [withFrame, withQueryCache(seedSkill({ removable: true }))],
};

/**
 * A skill that failed to load, with nothing cached to fall back on: the
 * error says so, in the error tone every panel uses for a failure.
 */
export const LoadError: Story = {
  decorators: [withFrame, withQueryCache()],
};
