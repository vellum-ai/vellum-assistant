/**
 * The notifications bell popover with nothing in it.
 *
 * The scene says only that there is nothing yet: an empty bell is not proof
 * that nothing is set up, because permission requests, replies that arrived
 * while the user was away, inbound channel requests, credential alerts, and
 * heartbeat failures all post here without a schedule involved.
 *
 * Under the title it may offer the schedule that would fill the panel. That
 * card is an advertisement, aimed at people who have not adopted schedules, so
 * it appears only while the user has none. Both outcomes are here, since the
 * scene has to hold together either way.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";

import { NotificationsBellEmptyState } from "@/domains/home/components/notifications-bell-empty-state";

const meta = {
  title: "Home/NotificationsBellEmptyState",
  component: NotificationsBellEmptyState,
  parameters: { layout: "centered" },
} satisfies Meta<typeof NotificationsBellEmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The width the panel actually gets (`w-96`), on the panel's own surface. */
function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="w-96 rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] p-2">
      {children}
    </div>
  );
}

/**
 * No schedules: the recipe is offered. No preview and no description, since
 * the panel's own "Notifications" heading sits above this.
 */
export const WithBriefingRecipe: Story = {
  render: () => (
    <Panel>
      <NotificationsBellEmptyState showBriefingRecipe />
    </Panel>
  ),
};

/**
 * What everyone else sees: someone who already has a schedule, and anyone
 * whose schedules have not loaded yet. The icon well and the title carry the
 * scene on their own, which is the case this story is here to check.
 */
export const TitleOnly: Story = {
  render: () => (
    <Panel>
      <NotificationsBellEmptyState />
    </Panel>
  ),
};
