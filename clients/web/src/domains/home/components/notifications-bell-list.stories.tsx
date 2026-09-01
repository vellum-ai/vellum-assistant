/**
 * `NotificationsBellList` is the bell's list view: the rows the popover
 * shows before a notification is opened. These stories render it at the
 * popover's real width, with the sectioning a pending guardian request
 * introduces and without it.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { NotificationsBellList } from "@/domains/home/components/notifications-bell-list";
import { feedItem } from "@/domains/home/feed-test-fixtures";

const PENDING_GUARDIAN = feedItem({
  id: "guardian:req-1",
  status: "new",
  urgency: "high",
  timestamp: "2026-08-05T14:30:00.000Z",
  createdAt: "2026-08-05T14:30:00.000Z",
  summary:
    "Alice asked the assistant to look up ticket ABC-123 before replying in the thread.",
  guardianRequest: {
    requestId: "req-1",
    kind: "tool_approval",
    intent: "approval",
    status: "pending",
    requesterLabel: "Alice",
    toolName: "linear_graphql",
    sourceChannel: "slack",
    sourceContextLabel: "Slack #user-feedback",
  },
});

const UPDATES = [
  feedItem({
    id: "update-1",
    status: "new",
    title: "Meeting notes captured",
    summary: "Notes from the weekly sync were filed to the project journal.",
    sourceLabel: "Schedule",
    timestamp: "2026-08-05T13:30:00.000Z",
    createdAt: "2026-08-05T13:30:00.000Z",
  }),
  feedItem({
    id: "update-2",
    status: "seen",
    title: "Skill updated: weekly-report",
    summary: "The report template gained a section for open questions.",
    timestamp: "2026-08-05T12:00:00.000Z",
    createdAt: "2026-08-05T12:00:00.000Z",
  }),
  feedItem({
    id: "update-3",
    status: "seen",
    title: "Morning briefing ready",
    summary: "Three meetings today, one conflict resolved.",
    timestamp: "2026-08-05T08:00:00.000Z",
    createdAt: "2026-08-05T08:00:00.000Z",
  }),
];

const meta = {
  title: "Home/NotificationsBellList",
  component: NotificationsBellList,
  parameters: { layout: "padded" },
  args: {
    onSelect: () => {},
    onDismiss: () => {},
    onToggleRead: () => {},
  },
  decorators: [
    (Story) => (
      <div className="flex w-96 flex-col gap-[var(--app-spacing-sm)] rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof NotificationsBellList>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A pending guardian request pins the list into sections: the request under
 * "Needs attention", everything else under "Updates".
 */
export const WithNeedsAttention: Story = {
  args: {
    items: [PENDING_GUARDIAN, ...UPDATES],
  },
};

/** With nothing waiting on the user, the list is a plain stack of rows. */
export const Unsectioned: Story = {
  args: {
    items: UPDATES,
  },
};
