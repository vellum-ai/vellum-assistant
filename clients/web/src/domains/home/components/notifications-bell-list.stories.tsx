/**
 * `NotificationsBellList` is what the bell shows before a notification is
 * opened.
 *
 * The decorator is the popover box the bell renders this into, and nothing
 * else: the list has no width of its own, so without it the rows would be
 * seen at a width they never have. Everything inside the box is the
 * component's own output.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { NotificationsBellList } from "@/domains/home/components/notifications-bell-list";
import { feedItem } from "@/domains/home/feed-test-fixtures";

import { PANEL_CONTENT_HEIGHT } from "./notifications-bell";

const UPDATES = [
  feedItem({
    id: "update-1",
    status: "new",
    title: "Repaired a corrupt git store",
    summary:
      "Caught this heartbeat's workspace-health failing and rebuilt the index.",
    timestamp: "2026-08-05T09:30:00.000Z",
    createdAt: "2026-08-05T09:30:00.000Z",
  }),
  feedItem({
    id: "update-2",
    status: "seen",
    title: "Heartbeat job miss",
    summary: "1 heartbeat run was missed while the assistant was asleep.",
    timestamp: "2026-08-04T09:30:00.000Z",
    createdAt: "2026-08-04T09:30:00.000Z",
  }),
  feedItem({
    id: "update-3",
    status: "seen",
    title: "Skill updated: Weekly Report Export",
    summary: 'Updated the skill "Weekly Report Export" from this pass.',
    timestamp: "2026-08-01T09:30:00.000Z",
    createdAt: "2026-08-01T09:30:00.000Z",
  }),
];

const PENDING_GUARDIAN = feedItem({
  id: "guardian:req-approval",
  status: "new",
  urgency: "high",
  title: "Alice asked the assistant to look up ticket ABC-123",
  summary:
    "Alice asked the assistant to look up ticket ABC-123 before replying in the thread.",
  category: "security",
  detailPanel: { kind: "permissionChat" },
  timestamp: "2026-08-05T14:30:00.000Z",
  createdAt: "2026-08-05T14:30:00.000Z",
  guardianRequest: {
    requestId: "req-approval",
    kind: "tool_approval",
    intent: "approval",
    status: "pending",
    requesterLabel: "Alice",
    toolName: "linear_graphql",
    sourceChannel: "slack",
    sourceContextLabel: "Slack #user-feedback",
  },
});

const meta = {
  title: "Home/NotificationsBellList",
  component: NotificationsBellList,
  parameters: { layout: "padded" },
  args: {
    maxHeight: PANEL_CONTENT_HEIGHT,
    onSelect: () => {},
    onDismiss: () => {},
    onToggleRead: () => {},
  },
  decorators: [
    (Story) => (
      <div className="w-96 rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof NotificationsBellList>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The ordinary case: notifications that report, newest first. */
export const Default: Story = {
  args: { items: UPDATES },
};

/**
 * A guardian request waiting on the user. It sorts above the rest and takes
 * the attention hue, so the one row to act on is the one that stands out.
 */
export const WithWaitingRequest: Story = {
  args: { items: [PENDING_GUARDIAN, ...UPDATES] },
};

/**
 * The same request once it is settled. Its receipt files with the ordinary
 * notifications and reads like them, with the row emphasis dropped.
 */
export const WithSettledRequest: Story = {
  args: {
    items: [
      feedItem({
        ...PENDING_GUARDIAN,
        id: "guardian:req-resolved",
        status: "seen",
        urgency: "medium",
        guardianRequest: {
          requestId: "req-resolved",
          kind: "tool_approval",
          intent: "approval",
          status: "approved",
          requesterLabel: "Alice",
          toolName: "linear_graphql",
          sourceContextLabel: "Slack #user-feedback",
        },
      }),
      ...UPDATES,
    ],
  },
};

/**
 * More notifications than the panel's height budget seats, which is where
 * the list scrolls inside the panel rather than growing it.
 */
export const Scrolling: Story = {
  args: {
    items: [
      PENDING_GUARDIAN,
      ...UPDATES,
      feedItem({
        id: "update-4",
        status: "seen",
        title: "Heads up, disk got tight",
        summary: "Workspace hit 89% after the build finished.",
        timestamp: "2026-07-30T09:30:00.000Z",
        createdAt: "2026-07-30T09:30:00.000Z",
      }),
      feedItem({
        id: "update-5",
        status: "seen",
        title: "Morning briefing ready",
        summary: "Three meetings today, one conflict resolved.",
        timestamp: "2026-07-29T09:30:00.000Z",
        createdAt: "2026-07-29T09:30:00.000Z",
      }),
    ],
  },
};
