/**
 * `NotificationsBellPanel` is the bell's list view as the user sees it: the
 * header with its count, the rows, and the bulk footer, inside the popover
 * box the bell draws it in. These stories are where every kind of
 * notification and every state of a guardian request is seen together at the
 * panel's real width, so a change to one row is checked against the rest.
 *
 * The bell owns the queries; the props here are what it passes down once the
 * feed and the conversation lists have resolved. Fixtures are
 * production-shaped: the daemon fills `summary` from the rendered copy and
 * `guardianRequest` from the gateway's projection.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";

import { NotificationsBellEmptyState } from "@/domains/home/components/notifications-bell-empty-state";
import { NotificationsBellList } from "@/domains/home/components/notifications-bell-list";
import { NotificationsBellPanel } from "@/domains/home/components/notifications-bell-panel";
import { feedItem } from "@/domains/home/feed-test-fixtures";
import { useTranslation } from "@/i18n";
import type { FeedItem } from "@vellumai/assistant-api";
import { Typography } from "@vellumai/design-library";

import { PANEL_CONTENT_HEIGHT } from "./notifications-bell";

/** The threads the fixtures below came from, as the conversation lists name them. */
const CONVERSATION_TITLES: ReadonlyMap<string, string> = new Map([
  ["conv-inbox", "Inbox triage"],
  ["conv-wedding", "Wedding planning"],
  ["conv-bosch", "Bosch diagnostic app"],
  ["conv-venue", "Venue shortlist"],
  ["conv-linear", "Linear ticket lookup"],
  ["conv-deck", "Q3 pricing deck"],
]);

/** Minutes ago, so the timestamps read the way the design's do. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function stamped(
  minutes: number,
  overrides: Partial<FeedItem> & Pick<FeedItem, "id">,
): FeedItem {
  const timestamp = minutesAgo(minutes);
  return feedItem({ timestamp, createdAt: timestamp, ...overrides });
}

// ── Rows that report ────────────────────────────────────────────────────────

/** Work the assistant finished on its own, unread. */
const EMAIL_RECAP = stamped(8, {
  id: "done-email-recap",
  status: "new",
  title: "Made recaps of 12 important emails and deleted 6",
  summary:
    "Recapped the 12 emails that needed a reply and deleted 6 newsletters.",
  category: "email",
  conversationId: "conv-inbox",
});

const WEDDING_SCHEDULE = stamped(8, {
  id: "done-wedding",
  status: "new",
  title: "Prepared a wedding schedule",
  summary: "The day-of schedule is drafted with the vendors' arrival times.",
  conversationId: "conv-wedding",
});

/** The same kind of row once it has been read: the dot fades. */
const BOSCH_APP = stamped(8, {
  id: "done-bosch",
  status: "seen",
  title: "Finished the Bosch fuel system diagnostic app",
  summary:
    "The diagnostic app builds and the fuel-pressure checks pass on the sample data.",
  category: "background",
  conversationId: "conv-bosch",
});

/** Named by the daemon's source label: no conversation to link to. */
const MEMORY_SWEEP = stamped(8, {
  id: "done-memory-sweep",
  status: "seen",
  title: "Skill updated: Weekly Report Export",
  summary: 'Updated the skill "Weekly Report Export" from this pass.',
  category: "background",
  sourceLabel: "Memory sweep",
});

/** No thread name at all: the daemon's generic source label is dropped. */
const NO_THREAD = stamped(8, {
  id: "done-no-thread",
  status: "seen",
  title: "Another thing I did but has no action",
  summary: "Nothing further to report on this one.",
  sourceLabel: "Other",
});

/** A scheduled run, named for its schedule. */
const MORNING_BRIEFING = stamped(180, {
  id: "done-briefing",
  status: "seen",
  title: "Morning briefing ready",
  summary: "Three meetings today, one conflict resolved.",
  category: "scheduling",
  sourceLabel: "Morning briefing",
});

/** A title long enough to have to yield to the timestamp. */
const LONG_TITLE = stamped(45, {
  id: "done-long-title",
  status: "new",
  title:
    "Reconciled the September vendor invoices against the purchase orders and flagged the three that disagree",
  summary:
    "Three invoices disagree with their purchase orders by more than 5%.",
  conversationId: "conv-inbox",
});

/**
 * A row the assistant attached offers to. The body previews under the title
 * because the offers act on it; opening the row shows them.
 */
const WITH_OFFERS = stamped(20, {
  id: "offers-pricing-deck",
  status: "new",
  title: "Alice wants notes on the Q3 deck",
  summary:
    "Alice replied about the Q3 pricing deck and wants your notes before Thursday's review.",
  category: "email",
  conversationId: "conv-deck",
  actions: [
    { id: "draft-reply", label: "Draft a reply", prompt: "Draft a reply" },
    { id: "summarize", label: "Summarize the deck", prompt: "Summarize" },
  ],
});

// ── Guardian requests ───────────────────────────────────────────────────────

/** A pending tool approval: the ask described, decided from the row. */
const TOOL_APPROVAL = stamped(8, {
  id: "guardian:req-tool",
  status: "new",
  urgency: "high",
  title: "Guardian Question",
  summary:
    "Alice asked the assistant to look up ticket ABC-123 in Linear before replying in the thread.",
  category: "security",
  detailPanel: { kind: "permissionChat" },
  conversationId: "conv-linear",
  guardianRequest: {
    requestId: "req-tool",
    kind: "tool_approval",
    intent: "approval",
    status: "pending",
    requesterLabel: "Alice",
    toolName: "linear_graphql",
    sourceChannel: "slack",
    sourceContextLabel: "#user-feedback",
  },
});

/** A pending grant: the assistant wants a skill it does not yet have. */
const SKILL_GRANT = stamped(8, {
  id: "guardian:req-grant",
  status: "new",
  urgency: "high",
  title: "Guardian Question",
  summary:
    "The assistant wants to use the Calendar skill to move Thursday's review, which needs write access to your calendar.",
  category: "security",
  detailPanel: { kind: "permissionChat" },
  conversationId: "conv-wedding",
  guardianRequest: {
    requestId: "req-grant",
    kind: "tool_grant_request",
    intent: "approval",
    status: "pending",
    toolName: "calendar_write",
  },
});

/** Someone new asking to talk to the assistant. */
const ACCESS_REQUEST = stamped(12, {
  id: "guardian:req-access",
  status: "new",
  urgency: "high",
  title: "Access Request",
  summary:
    "Bob Chen (+1 415 555 0134) wants to reach your assistant over WhatsApp.",
  category: "security",
  detailPanel: { kind: "permissionChat" },
  guardianRequest: {
    requestId: "req-access",
    kind: "access_request",
    intent: "approval",
    status: "pending",
    requesterLabel: "Bob Chen",
    sourceChannel: "whatsapp",
  },
});

/** A pending question: the ask quoted, answered in the conversation. */
const QUESTION = stamped(8, {
  id: "guardian:req-question",
  status: "new",
  urgency: "high",
  title: "Guardian Question",
  summary: "You're reaching the limit of your current plan. Upgrade now?",
  category: "security",
  detailPanel: { kind: "permissionChat" },
  conversationId: "conv-venue",
  guardianRequest: {
    requestId: "req-question",
    kind: "pending_question",
    intent: "question",
    status: "pending",
  },
});

/** The tool approval once it was approved: a receipt, read like any row. */
const APPROVED = stamped(60, {
  ...TOOL_APPROVAL,
  id: "guardian:req-approved",
  status: "seen",
  urgency: "medium",
  guardianRequest: {
    ...TOOL_APPROVAL.guardianRequest!,
    requestId: "req-approved",
    status: "approved",
    decidedAction: "approve_once",
    decidedAt: minutesAgo(55),
  },
});

const REJECTED = stamped(90, {
  ...SKILL_GRANT,
  id: "guardian:req-rejected",
  status: "seen",
  urgency: "medium",
  guardianRequest: {
    ...SKILL_GRANT.guardianRequest!,
    requestId: "req-rejected",
    status: "denied",
    decidedAction: "reject",
    decidedAt: minutesAgo(85),
  },
});

/** A question that was answered in its conversation. */
const ANSWERED = stamped(120, {
  ...QUESTION,
  id: "guardian:req-answered",
  status: "seen",
  urgency: "medium",
  guardianRequest: {
    ...QUESTION.guardianRequest!,
    requestId: "req-answered",
    status: "approved",
    decidedAt: minutesAgo(110),
  },
});

/** Nobody decided: the request timed out. */
const EXPIRED = stamped(600, {
  ...ACCESS_REQUEST,
  id: "guardian:req-expired",
  status: "seen",
  urgency: "medium",
  guardianRequest: {
    ...ACCESS_REQUEST.guardianRequest!,
    requestId: "req-expired",
    status: "expired",
    decidedAt: minutesAgo(540),
  },
});

// ── Composition ─────────────────────────────────────────────────────────────

/** The bell in the design's order: what is waiting on the user, then the rest. */
const DESIGN_FEED = [
  EMAIL_RECAP,
  WEDDING_SCHEDULE,
  BOSCH_APP,
  NO_THREAD,
  QUESTION,
  MEMORY_SWEEP,
  MORNING_BRIEFING,
  TOOL_APPROVAL,
];

/**
 * The popover box the bell renders the panel into, so the stories are seen
 * at the panel's real width and on its real surface.
 */
function PopoverFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-[435px] min-w-0 flex-col rounded-[var(--radius-xl)] bg-[var(--surface-lift)] shadow-[var(--shadow-popover)]">
      {children}
    </div>
  );
}

/** The bell's failure notice, as it renders it in place of the list. */
function LoadFailed() {
  const { t } = useTranslation("home");
  return (
    <Typography
      variant="body-medium-lighter"
      className="px-[var(--app-spacing-lg)] py-[var(--app-spacing-xl)] text-center text-[var(--content-tertiary)]"
    >
      {t("notificationsBell.loadFailed")}
    </Typography>
  );
}

interface PanelStoryArgs {
  items: FeedItem[];
  /** Whether the daemon supports the bulk footer. */
  supportsBulkStatus: boolean;
  isBulkPending: boolean;
  isDecisionPending: boolean;
}

// No `component`: the stories are driven by the feed rather than by the
// panel's own props, since the panel is only ever seen wrapped around a list.
const meta = {
  title: "Home/NotificationsBellPanel",
  parameters: { layout: "padded" },
  args: {
    items: DESIGN_FEED,
    supportsBulkStatus: true,
    isBulkPending: false,
    isDecisionPending: false,
  },
  render: ({ items, supportsBulkStatus, isBulkPending, isDecisionPending }) => (
    <PopoverFrame>
      <NotificationsBellPanel
        count={items.length}
        hasUnread={items.some((item) => item.status === "new")}
        showsBulkActions={supportsBulkStatus && items.length > 0}
        isBulkPending={isBulkPending}
        onMarkAllRead={() => {}}
        onClearAll={() => {}}
      >
        <NotificationsBellList
          items={items}
          maxHeight={PANEL_CONTENT_HEIGHT}
          conversationTitles={CONVERSATION_TITLES}
          onSelect={() => {}}
          onDismiss={() => {}}
          onToggleRead={() => {}}
          onDecide={() => {}}
          isDecisionPending={isDecisionPending}
        />
      </NotificationsBellPanel>
    </PopoverFrame>
  ),
} satisfies Meta<PanelStoryArgs>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The design's mix: work that only reports, a question waiting on the user,
 * and a tool approval decided from its row. The list sorts what is waiting
 * to the top in the real bell; here the order is the design's.
 */
export const Default: Story = {};

/**
 * Every shape a row that reports can take: unread and read, named by its
 * conversation, by its schedule, by nothing, with a title that has to yield
 * to the timestamp, and with offers attached.
 */
export const Reports: Story = {
  args: {
    items: [
      EMAIL_RECAP,
      WEDDING_SCHEDULE,
      LONG_TITLE,
      WITH_OFFERS,
      BOSCH_APP,
      MEMORY_SWEEP,
      MORNING_BRIEFING,
      NO_THREAD,
    ],
  },
};

/**
 * Every state of a guardian request. Pending approvals describe the ask and
 * offer Approve / Reject; a pending question quotes the ask and is answered
 * in its conversation; the settled ones read as receipts, by their own
 * titles, with nothing underneath.
 */
export const GuardianRequests: Story = {
  args: {
    items: [
      TOOL_APPROVAL,
      SKILL_GRANT,
      ACCESS_REQUEST,
      QUESTION,
      APPROVED,
      REJECTED,
      ANSWERED,
      EXPIRED,
    ],
  },
};

/**
 * A decision in flight: every pending approval's buttons go inert together,
 * so no second request can be decided by a stray click.
 */
export const DecisionPending: Story = {
  args: {
    items: [TOOL_APPROVAL, SKILL_GRANT, QUESTION],
    isDecisionPending: true,
  },
};

/** Everything read: "Mark all as read" drops out of the footer. */
export const AllRead: Story = {
  args: {
    items: [BOSCH_APP, MEMORY_SWEEP, MORNING_BRIEFING, APPROVED],
  },
};

/** A bulk action in flight: both footer buttons held inert. */
export const BulkPending: Story = {
  args: {
    items: [EMAIL_RECAP, BOSCH_APP],
    isBulkPending: true,
  },
};

/**
 * A daemon without the bulk status route: the footer is withheld and the
 * rows' own controls are the only way to clear anything.
 */
export const WithoutBulkActions: Story = {
  args: {
    items: [EMAIL_RECAP, WEDDING_SCHEDULE, BOSCH_APP],
    supportsBulkStatus: false,
  },
};

/**
 * More than the height budget seats, which is where the list scrolls inside
 * the panel rather than growing it.
 */
export const Scrolling: Story = {
  args: {
    items: [
      TOOL_APPROVAL,
      QUESTION,
      ...DESIGN_FEED.filter(
        (item) => item !== TOOL_APPROVAL && item !== QUESTION,
      ),
      LONG_TITLE,
      WITH_OFFERS,
      APPROVED,
      EXPIRED,
    ],
  },
};

/** Nothing yet, with the briefing recipe offered to someone with no schedules. */
export const Empty: Story = {
  render: () => (
    <PopoverFrame>
      <NotificationsBellPanel
        count={0}
        hasUnread={false}
        showsBulkActions={false}
        onMarkAllRead={() => {}}
        onClearAll={() => {}}
      >
        <div className="px-[var(--app-spacing-lg)] pt-[var(--app-spacing-lg)]">
          <NotificationsBellEmptyState showBriefingRecipe />
        </div>
      </NotificationsBellPanel>
    </PopoverFrame>
  ),
};

/** Nothing yet, for someone who already has a schedule. */
export const EmptyWithoutRecipe: Story = {
  render: () => (
    <PopoverFrame>
      <NotificationsBellPanel
        count={0}
        hasUnread={false}
        showsBulkActions={false}
        onMarkAllRead={() => {}}
        onClearAll={() => {}}
      >
        <div className="px-[var(--app-spacing-lg)] pt-[var(--app-spacing-lg)]">
          <NotificationsBellEmptyState />
        </div>
      </NotificationsBellPanel>
    </PopoverFrame>
  ),
};

/** The feed could not be loaded: the notice stands in for the list. */
export const LoadFailedState: Story = {
  render: () => (
    <PopoverFrame>
      <NotificationsBellPanel
        count={0}
        hasUnread={false}
        showsBulkActions={false}
        onMarkAllRead={() => {}}
        onClearAll={() => {}}
      >
        <LoadFailed />
      </NotificationsBellPanel>
    </PopoverFrame>
  ),
};
