/**
 * `HomeDetailPanel` is what opens when a row in the Home activity feed is
 * clicked. It renders a header (title, category tag, timestamp, and the
 * actions for that item) over either a panel specialized to
 * `item.detailPanel.kind` or, for everything without one, `HomeGenericDetail`,
 * which is just the item's `summary` rendered as markdown.
 *
 * Most background producers set no `detailPanel`, so the generic body is the
 * common case and these stories lead with it. That is worth seeing directly:
 * an item whose summary is a single sentence opens to that same sentence,
 * which is the whole detail view.
 *
 * Fixtures come from the shared feed fixtures so a panel story and its row
 * story describe the same item.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Brain, Calendar } from "lucide-react";

import {
  feedItem,
  FIXTURE_CONVERSATION_ID,
  FIXTURE_VALID_CONVERSATIONS,
} from "@/domains/home/feed-test-fixtures";
import { HomeDetailPanel } from "@/domains/home/detail-panel/home-detail-panel";
import { routes } from "@/utils/routes";

const meta = {
  title: "Home/HomeDetailPanel",
  component: HomeDetailPanel,
  parameters: { layout: "padded" },
  args: {
    validConversationIds: FIXTURE_VALID_CONVERSATIONS,
    onClose: () => {},
    onGoToThread: () => {},
    onUpdateStatus: () => {},
    onDismiss: () => {},
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof HomeDetailPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A background pass updated a skill. The item carries no `detailPanel`, so the
 * body is the summary as markdown: the same sentence the row already
 * displayed, at full width. The panel names a skill it cannot show, so the
 * footer carries a link to it, resolved from `metadata.skillId` by
 * `useFeedItemEntityLinks` and offered only while that skill still exists.
 */
export const SkillUpdated: Story = {
  args: {
    entityLinks: [
      {
        kind: "skill",
        labelKey: "actions.viewSkill",
        icon: Brain,
        to: routes.skills.detail("weekly-report-export"),
      },
    ],
    onNavigate: () => {},
    item: feedItem({
      id: "feed-skill-updated",
      title: "Skill updated: Weekly Report Export",
      summary:
        'Updated the skill "Weekly Report Export" from something learned in an earlier conversation.',
      category: "background",
      urgency: "low",
      metadata: { skillId: "weekly-report-export" },
      conversationId: FIXTURE_CONVERSATION_ID,
    }),
  },
};

/**
 * A failed background job. `activity.failed`'s composed body carries the
 * error kind and message, so the panel has more to show than the row's
 * single preview line.
 */
export const BackgroundJobFailed: Story = {
  args: {
    item: feedItem({
      id: "feed-sweep-failed",
      title: "Background job failed: memory.v2.sweep",
      summary:
        "exception: Qdrant collection `memory_v2_concept_pages` is unavailable after 3 retries.\n\nThe sweep will retry on its next scheduled pass. Concept pages stay readable in the meantime; only re-embedding is paused.",
      category: "background",
      urgency: "medium",
      sourceLabel: "Memory sweep",
      conversationId: FIXTURE_CONVERSATION_ID,
    }),
  },
};

/**
 * A summary with real markdown structure. The generic body renders it through
 * `HomeMarkdownContent`, so lists and emphasis survive here even though the
 * row flattened them for its preview line.
 */
export const MarkdownSummary: Story = {
  args: {
    item: feedItem({
      id: "feed-markdown",
      title: "Nightly maintenance finished",
      summary:
        "**Nightly maintenance finished.**\n\n- Reindexed 1,204 concept pages\n- Pruned 18 stale embeddings\n- Skipped 2 pages that failed validation\n\nNothing needs your attention; this is recorded for the audit trail.",
      category: "system",
      urgency: "low",
    }),
  },
};

/**
 * No linkable conversation. The panel drops its jump action rather than
 * offering a target that cannot resolve.
 */
export const WithoutConversation: Story = {
  args: {
    item: feedItem({
      id: "feed-no-conversation",
      title: "Activity Complete",
      summary: "Finished the nightly memory consolidation pass.",
      category: "background",
      urgency: "low",
    }),
  },
};

/** Already dismissed: the panel offers restore rather than dismiss. */
export const Dismissed: Story = {
  args: {
    item: feedItem({
      id: "feed-dismissed",
      title: "Skill updated: Weekly Report Export",
      summary: 'Updated the skill "Weekly Report Export".',
      category: "background",
      urgency: "low",
      status: "dismissed",
      conversationId: FIXTURE_CONVERSATION_ID,
    }),
  },
};

/**
 * A schedule-sourced item whose schedule still exists, so the panel offers a
 * jump to it alongside the conversation.
 */
export const FromSchedule: Story = {
  args: {
    entityLinks: [
      {
        kind: "schedule",
        labelKey: "actions.viewSchedule",
        icon: Calendar,
        to: routes.schedules.detail("weekly-report"),
      },
    ],
    onNavigate: () => {},
    item: feedItem({
      id: "feed-schedule",
      title: "Weekly report is due",
      summary:
        "Your Monday recap is ready to send. The draft covers last week's shipped work.",
      category: "scheduling",
      urgency: "medium",
      sourceLabel: "Schedule",
      conversationId: FIXTURE_CONVERSATION_ID,
    }),
  },
};

/**
 * The mobile layout, which the panel branches to before its desktop shell.
 *
 * Framed at a fixed height because that branch is `h-full`: inside a
 * height-less wrapper its scroll region has nothing to overflow against, so
 * the treatment under test would not render.
 */
export const Mobile: Story = {
  decorators: [
    (Story) => (
      <div className="h-[32rem]">
        <Story />
      </div>
    ),
  ],
  args: {
    isMobile: true,
    item: feedItem({
      id: "feed-skill-updated-mobile",
      title: "Skill updated: Weekly Report Export",
      summary:
        'Updated the skill "Weekly Report Export" from something learned in an earlier conversation.',
      category: "background",
      urgency: "low",
      conversationId: FIXTURE_CONVERSATION_ID,
    }),
  },
};
