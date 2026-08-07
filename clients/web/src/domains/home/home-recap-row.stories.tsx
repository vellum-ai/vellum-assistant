/**
 * `HomeRecapRow` is the row the Home activity feed renders for every
 * notification the daemon mirrors into it (`notifications/home-feed-side-effect.ts`).
 * It is the only place background work becomes visible without opening a
 * conversation, so these stories cover the shapes it actually receives:
 * a failed background job, a completed one, a scheduled reminder, and a
 * guardian request.
 *
 * Fixtures are production-shaped. The daemon fills `summary` from the
 * rendered channel copy (falling back to the signal's `contextPayload`
 * `body`/`title`), so it arrives as markdown and the row flattens it for the
 * title line: `Failing` therefore carries a real multi-line body rather than
 * a pre-flattened string, which is what exercises `flattenSummary` /
 * `resolvePreview`.
 *
 * `category` drives the chip hue and comes from `EVENT_CATEGORY_MAP` in the
 * side effect, so each story sets the one its source event maps to.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  feedItem,
  FIXTURE_CONVERSATION_ID,
  FIXTURE_VALID_CONVERSATIONS,
} from "@/domains/home/feed-test-fixtures";
import { HomeRecapRow } from "@/domains/home/home-recap-row";

const meta = {
  title: "Home/HomeRecapRow",
  component: HomeRecapRow,
  parameters: { layout: "padded" },
  args: {
    onSelect: () => {},
    onDismiss: () => {},
    onToggleRead: () => {},
    onGoToThread: () => {},
    validConversationIds: FIXTURE_VALID_CONVERSATIONS,
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof HomeRecapRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A background job that failed. `activity.failed` is the most common feed
 * producer today (the memory sweep, the scheduler, the background job
 * runner), and its copy composer emits `Background job failed: <jobName>`
 * with `<errorKind>: <message>` as the body.
 */
export const BackgroundJobFailed: Story = {
  args: {
    item: feedItem({
      id: "feed-sweep-failed",
      title: "Background job failed: memory.v2.sweep",
      summary:
        "exception: Qdrant collection `memory_v2_concept_pages` is unavailable after 3 retries.",
      category: "background",
      urgency: "medium",
      sourceLabel: "Memory sweep",
    }),
  },
};

/**
 * A background pass updated a skill the assistant had already written. This
 * is the shape the retrospective's `activity.complete` signal produces: the
 * work happened inside a hidden background fork, so the feed row is the only
 * place it surfaces, and `conversationId` points at the conversation the
 * procedure came from rather than the fork.
 */
export const SkillUpdated: Story = {
  args: {
    item: feedItem({
      id: "feed-skill-updated",
      title: "Skill updated: Weekly Report Export",
      summary:
        'Updated the skill "Weekly Report Export" from something learned in an earlier conversation.',
      category: "background",
      urgency: "low",
      conversationId: FIXTURE_CONVERSATION_ID,
    }),
  },
};

/** A scheduled reminder firing: `schedule.notify`, category `scheduling`. */
export const ScheduledReminder: Story = {
  args: {
    item: feedItem({
      id: "feed-schedule",
      title: "Weekly report is due",
      summary:
        "Your Monday recap is ready to send. The draft covers last week's shipped work.",
      category: "scheduling",
      urgency: "medium",
      conversationId: FIXTURE_CONVERSATION_ID,
      sourceLabel: "Schedule",
    }),
  },
};

/** A guardian request: `security` category, high urgency. */
export const SecurityRequest: Story = {
  args: {
    item: feedItem({
      id: "feed-guardian",
      title: "Approval needed",
      summary:
        "A tool wants to send an email on your behalf to the finance team.",
      category: "security",
      urgency: "high",
      conversationId: FIXTURE_CONVERSATION_ID,
    }),
  },
};

/**
 * Already seen. The unread affordance flips (`Mail` becomes `MailOpen`) and
 * the row loses its unread emphasis, so this is the state most rows sit in
 * after a first visit.
 */
export const Read: Story = {
  args: {
    item: feedItem({
      ...SkillUpdated.args.item,
      id: "feed-skill-updated-read",
      status: "seen",
    }),
  },
};

/**
 * No linkable conversation. The row hides "Go to thread" entirely rather
 * than offering a dead target, which is what happens once a background fork
 * is garbage collected or when a producer's source context is a sentinel
 * rather than a real conversation.
 */
export const WithoutConversation: Story = {
  args: {
    item: feedItem({
      id: "feed-no-conversation",
      title: "Activity Complete",
      summary: "Finished the nightly memory consolidation pass.",
      category: "background",
      urgency: "low",
      sourceLabel: "Memory consolidation",
    }),
  },
};

/**
 * A conversation id the feed cannot resolve. `validConversationIds` gates the
 * jump target, so a stale id degrades to the same treatment as no id at all
 * instead of navigating into a deleted thread.
 */
export const StaleConversationLink: Story = {
  args: {
    item: feedItem({
      id: "feed-stale-link",
      title: "Skill updated: Weekly Report Export",
      summary: 'Updated the skill "Weekly Report Export".',
      category: "background",
      urgency: "low",
      conversationId: "conv-deleted-fork",
    }),
  },
};

/**
 * Markdown summary with no title of its own. The row flattens the summary for
 * the title line and derives the preview from what is left, so structure in
 * the body never leaks into the header as syntax.
 */
export const MarkdownSummaryWithoutTitle: Story = {
  args: {
    item: feedItem({
      id: "feed-markdown",
      summary:
        "**Nightly maintenance finished.**\n\n- Reindexed 1,204 concept pages\n- Pruned 18 stale embeddings\n- Skipped 2 pages that failed validation",
      category: "system",
      urgency: "low",
    }),
  },
};

/** The compact density the feed uses where vertical space is tight. */
export const Compact: Story = {
  args: {
    density: "compact",
    item: feedItem({
      ...SkillUpdated.args.item,
      id: "feed-skill-updated-compact",
    }),
  },
};

/** Selected, as when its detail panel is open beside the list. */
export const Active: Story = {
  args: {
    isActive: true,
    item: feedItem({
      ...SkillUpdated.args.item,
      id: "feed-skill-updated-active",
    }),
  },
};

/**
 * A dismissed row offers restore instead of dismiss, the treatment the
 * feed uses in its dismissed filter.
 */
export const Restorable: Story = {
  args: {
    trailingAction: "restore",
    item: feedItem({
      ...SkillUpdated.args.item,
      id: "feed-skill-updated-dismissed",
      status: "dismissed",
    }),
  },
};
