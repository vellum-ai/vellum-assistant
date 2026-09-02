/**
 * `NotificationsBellDetail` is one notification opened inside the bell in the
 * top bar. It is the only surface a notification's full detail has, so these
 * stories are where every body kind is seen at its real width.
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
    // The bell's own content budget: five compact cards plus their gaps.
    contentHeight: "397px",
    contentMaxHeight: "calc(100dvh - 176px)",
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

/**
 * A pending guardian approval: the canonical "Needs attention" item for a
 * request raised from a channel. The body is the guardian card with
 * the ask and where it came from first, then the tool the request would
 * run, then Approve/Reject against the canonical request, with the
 * source-thread link under them.
 */
export const GuardianApprovalPending: Story = {
  args: {
    item: feedItem({
      id: "guardian:req-approval",
      title: "Alice asked the assistant to look up ticket ABC-123",
      summary:
        "Alice asked the assistant to look up ticket ABC-123 before replying in the thread.",
      category: "security",
      urgency: "high",
      detailPanel: { kind: "permissionChat" },
      conversationId: FIXTURE_CONVERSATION_ID,
      guardianRequest: {
        requestId: "req-approval",
        kind: "tool_approval",
        intent: "approval",
        status: "pending",
        requesterLabel: "Alice",
        toolName: "linear_graphql",
        sourceChannel: "slack",
        sourceContextLabel: "Slack #user-feedback",
        sourceUrl: "https://slack.com/archives/C0123456789/p1725100000000100",
      },
    }),
  },
};

/**
 * A pending guardian question routes to the source conversation to answer.
 * The summary is the question with its options on their own lines, which is
 * all the bell shows: the reply mechanics a chat channel needs are stripped
 * before the copy reaches this surface.
 */
export const GuardianQuestionPending: Story = {
  args: {
    item: feedItem({
      id: "guardian:req-question",
      title: "Which venue should I book?",
      summary:
        "Which venue should I book for the offsite? The two on the shortlist differ on price and travel time.\n\n1. The lakeside lodge\n2. The downtown hotel\n3. Either, your call",
      category: "security",
      urgency: "high",
      detailPanel: { kind: "permissionChat" },
      conversationId: FIXTURE_CONVERSATION_ID,
      guardianRequest: {
        requestId: "req-question",
        kind: "pending_question",
        intent: "question",
        status: "pending",
      },
    }),
  },
};

/**
 * The terminal receipt: the same item after resolution, with the outcome
 * in place of the buttons and the row an ordinary clearable
 * notification.
 */
export const GuardianApprovalResolved: Story = {
  args: {
    item: feedItem({
      id: "guardian:req-resolved",
      title: "Alice asked the assistant to look up ticket ABC-123",
      summary:
        "Alice asked the assistant to look up ticket ABC-123 before replying in the thread.",
      category: "security",
      urgency: "medium",
      detailPanel: { kind: "permissionChat" },
      conversationId: FIXTURE_CONVERSATION_ID,
      guardianRequest: {
        requestId: "req-resolved",
        kind: "tool_approval",
        intent: "approval",
        status: "approved",
        requesterLabel: "Alice",
        toolName: "linear_graphql",
        sourceContextLabel: "Slack #user-feedback",
        decidedAt: "2026-08-31T13:00:00.000Z",
      },
    }),
  },
};
