/**
 * The notifications bell popover with nothing in it.
 *
 * Notifications are produced by schedules and reminders, so an empty popover
 * means nothing has been set up yet. The scene says that and offers the
 * schedule that fixes it, which is what this story is here to show.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { NotificationsBellEmptyState } from "@/domains/home/components/notifications-bell-empty-state";

const meta = {
  title: "Home/NotificationsBellEmptyState",
  component: NotificationsBellEmptyState,
  parameters: { layout: "centered" },
} satisfies Meta<typeof NotificationsBellEmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * At the width the panel actually gets (`w-96`). No preview and no
 * description: the panel's own "Notifications" heading sits above it.
 */
export const BellPopover: Story = {
  render: () => (
    <div className="w-96 rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] p-2">
      <NotificationsBellEmptyState />
    </div>
  ),
};
