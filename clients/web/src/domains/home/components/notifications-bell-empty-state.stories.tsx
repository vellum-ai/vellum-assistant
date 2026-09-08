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

/**
 * The width the panel actually gets (435px), on the panel's own surface,
 * with the padding the bell puts around the scene.
 */
function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="w-[435px] rounded-[var(--radius-xl)] bg-[var(--surface-lift)] p-[var(--app-spacing-lg)] shadow-[var(--shadow-popover)]">
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
