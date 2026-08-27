/**
 * The two notification surfaces with nothing in them.
 *
 * Notifications are produced by schedules and reminders, so an empty feed
 * means nothing has been set up yet. Both scenes say that and offer the
 * schedule that fixes it, which is what these stories are here to show.
 *
 * Storybook has no assistant, so the hero renders its bell fallback rather
 * than a character avatar. The live page leads with the assistant's own face
 * whenever it has one.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  NotificationsBellEmptyState,
  NotificationsEmptyState,
} from "@/domains/home/components/notifications-empty-state";

const meta = {
  title: "Home/NotificationsEmptyState",
  component: NotificationsEmptyState,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof NotificationsEmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The Activity page: preview rows, two recipes, and the route to schedules. */
export const ActivityFeed: Story = {};

/**
 * The bell popover, at the width the panel actually gets (`w-96`). No preview
 * and no description: the panel's own "Notifications" heading sits above it.
 */
export const BellPopover: StoryObj<typeof NotificationsBellEmptyState> = {
  render: () => (
    <div className="w-96 rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] p-2">
      <NotificationsBellEmptyState />
    </div>
  ),
};
