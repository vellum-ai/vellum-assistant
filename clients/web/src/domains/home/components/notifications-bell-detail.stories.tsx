/**
 * `NotificationsBellDetail` is one notification opened inside the bell in the
 * top bar, which is a different surface from the Activity page's
 * `HomeDetailPanel` even though the two share their body renderers. This is
 * the one that appears under the bell icon.
 *
 * The decorator stands in for the popover the bell renders this into: the
 * same `w-96` box and padding as `notifications-bell.tsx`, so the footer's
 * links are seen at the width they actually have to fit. The bell itself owns
 * the queries, so the props here are what the real bell passes down after
 * `useFeedItemEntityLinks` has resolved.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Brain, Calendar } from "lucide-react";

import { NotificationsBellDetail } from "@/domains/home/components/notifications-bell-detail";
import {
  feedItem,
  FIXTURE_CONVERSATION_ID,
  FIXTURE_VALID_CONVERSATIONS,
} from "@/domains/home/feed-test-fixtures";
import type { FeedItemEntityLink } from "@/domains/home/hooks/use-feed-item-entity-links";
import { routes } from "@/utils/routes";

const SKILL_LINK: FeedItemEntityLink = {
  kind: "skill",
  labelKey: "actions.viewSkill",
  icon: Brain,
  to: routes.skills.detail("approved-pr-merge-gate"),
};

const SCHEDULE_LINK: FeedItemEntityLink = {
  kind: "schedule",
  labelKey: "actions.viewSchedule",
  icon: Calendar,
  to: routes.schedules.detail("weekly-report"),
};

const meta = {
  title: "Home/NotificationsBellDetail",
  component: NotificationsBellDetail,
  parameters: { layout: "padded" },
  args: {
    // The bell's own content budget: five compact cards plus their gaps,
    // clamped against a viewport too short to seat them.
    contentMaxHeight: "min(397px, calc(100dvh - 176px))",
    validConversationIds: FIXTURE_VALID_CONVERSATIONS,
    areConversationListsPending: false,
    entityLinks: [],
    areEntityLinksPending: false,
    isActionPending: false,
    onBack: () => {},
    onGoToConversation: () => {},
    onNavigate: () => {},
    onUpdateStatus: () => {},
    onDismiss: () => {},
    onTriggerAction: () => {},
  },
  decorators: [
    (Story) => (
      <div className="w-96 rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof NotificationsBellDetail>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A background pass rewrote a skill the user already had. The notification
 * names the skill in its title but cannot show it, so the footer carries a
 * link to it next to the jump back to the conversation the change came from.
 */
export const SkillUpdated: Story = {
  args: {
    entityLinks: [SKILL_LINK],
    item: feedItem({
      id: "feed-skill-updated",
      title: "Skill updated: Approved PR Merge Gate + Receipt",
      summary:
        'Updated the skill "Approved PR Merge Gate + Receipt" from something learned in an earlier conversation.',
      category: "background",
      urgency: "low",
      metadata: { skillId: "approved-pr-merge-gate" },
      conversationId: FIXTURE_CONVERSATION_ID,
    }),
  },
};

/**
 * The same notification for a skill that has since been removed. The resolver
 * drops a link whose target is gone, so the footer falls back to the
 * conversation alone rather than offering a dead end.
 */
export const SkillSinceRemoved: Story = {
  args: {
    entityLinks: [],
    item: feedItem({
      id: "feed-skill-removed",
      title: "Skill updated: Approved PR Merge Gate + Receipt",
      summary:
        'Updated the skill "Approved PR Merge Gate + Receipt" from something learned in an earlier conversation.',
      category: "background",
      urgency: "low",
      metadata: { skillId: "approved-pr-merge-gate" },
      conversationId: FIXTURE_CONVERSATION_ID,
    }),
  },
};

/**
 * A body past the cap, the one case the region scrolls for. Worth looking at
 * next to `SkillUpdated`, which sits well under it: the cap is what separates
 * them, so only this story reaches the full height.
 */
export const LongBody: Story = {
  args: {
    item: feedItem({
      id: "feed-long-body",
      title: "Background job failed: memory.v2.sweep",
      summary: [
        "exception: Qdrant collection `memory_v2_concept_pages` is unavailable after 3 retries.",
        "",
        "The sweep will retry on its next scheduled pass. Concept pages stay readable in the meantime; only re-embedding is paused.",
        "",
        "**What ran before the failure**",
        "",
        "- Reindexed 1,204 concept pages",
        "- Pruned 18 stale embeddings",
        "- Skipped 2 pages that failed validation",
        "",
        "**What to check**",
        "",
        "1. Whether the collection exists at all, which a failed migration can leave half-created.",
        "2. Whether the daemon's file-descriptor limit is the one it inherited from launchd rather than the raised one.",
        "3. Whether the retry budget is being spent on a host that is never coming back.",
      ].join("\n"),
      category: "background",
      urgency: "medium",
      conversationId: FIXTURE_CONVERSATION_ID,
    }),
  },
};

/** A scheduled run, the link this footer carried before skills joined it. */
export const FromSchedule: Story = {
  args: {
    entityLinks: [SCHEDULE_LINK],
    item: feedItem({
      id: "feed-schedule",
      title: "Weekly report is due",
      summary:
        "Your Monday recap is ready to send. The draft covers last week's shipped work.",
      category: "scheduling",
      urgency: "medium",
      metadata: { scheduleId: "weekly-report" },
      conversationId: FIXTURE_CONVERSATION_ID,
    }),
  },
};

/**
 * Every link at once, which is where the footer's width is actually tested:
 * three controls plus the timestamp inside a 384px popover. They wrap under
 * the timestamp rather than widening the panel or overflowing it.
 */
export const EveryLink: Story = {
  args: {
    entityLinks: [SCHEDULE_LINK, SKILL_LINK],
    item: feedItem({
      id: "feed-every-link",
      title: "Skill updated: Weekly Report Export",
      summary:
        'A scheduled run rewrote the skill "Weekly Report Export" from what it learned on this pass.',
      category: "background",
      urgency: "low",
      metadata: {
        scheduleId: "weekly-report",
        skillId: "approved-pr-merge-gate",
      },
      conversationId: FIXTURE_CONVERSATION_ID,
    }),
  },
};

/**
 * The state between opening the detail and the lists resolving. Both links
 * hold their box invisibly, so the footer does not change shape under the
 * cursor once validation lands, and neither is clickable meanwhile.
 */
export const LinksPending: Story = {
  args: {
    entityLinks: [SKILL_LINK],
    areEntityLinksPending: true,
    areConversationListsPending: true,
    item: feedItem({
      id: "feed-skill-pending",
      title: "Skill updated: Approved PR Merge Gate + Receipt",
      summary:
        'Updated the skill "Approved PR Merge Gate + Receipt" from something learned in an earlier conversation.',
      category: "background",
      urgency: "low",
      metadata: { skillId: "approved-pr-merge-gate" },
      conversationId: FIXTURE_CONVERSATION_ID,
    }),
  },
};
