import type { Meta, StoryObj } from "@storybook/react-vite";

import { Tabs } from "./tabs";

const meta: Meta<typeof Tabs.Root> = {
  title: "Components/Tabs",
  component: Tabs.Root,
  args: {
    defaultValue: "overview",
  },
  argTypes: {
    defaultValue: {
      control: "inline-radio",
      options: ["overview", "activity", "settings"],
    },
  },
};

export default meta;

type Story = StoryObj<typeof Tabs.Root>;

const PANEL_CLASS =
  "py-4 text-body-medium-lighter text-[var(--content-secondary)]";

/**
 * Arg-driven: pick which tab starts active from the Controls panel. Radix owns
 * the active state after mount (uncontrolled via `defaultValue`); the render
 * function composes the List / Trigger / Panel parts and spreads the Root args.
 */
export const Default: Story = {
  render: (args) => (
    <div style={{ width: 440 }}>
      <Tabs.Root {...args}>
        <Tabs.List>
          <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
          <Tabs.Trigger value="activity">Activity</Tabs.Trigger>
          <Tabs.Trigger value="settings">Settings</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Panel value="overview" className={PANEL_CLASS}>
          A summary of the workspace and its recent activity.
        </Tabs.Panel>
        <Tabs.Panel value="activity" className={PANEL_CLASS}>
          A chronological feed of everything that happened here.
        </Tabs.Panel>
        <Tabs.Panel value="settings" className={PANEL_CLASS}>
          Configuration for this workspace.
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  ),
};

/** A disabled trigger is skipped by keyboard navigation and can't be selected. */
export const WithDisabledTab: Story = {
  render: (args) => (
    <div style={{ width: 440 }}>
      <Tabs.Root {...args}>
        <Tabs.List>
          <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
          <Tabs.Trigger value="activity">Activity</Tabs.Trigger>
          <Tabs.Trigger value="settings" disabled>
            Settings
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Panel value="overview" className={PANEL_CLASS}>
          A summary of the workspace and its recent activity.
        </Tabs.Panel>
        <Tabs.Panel value="activity" className={PANEL_CLASS}>
          A chronological feed of everything that happened here.
        </Tabs.Panel>
        <Tabs.Panel value="settings" className={PANEL_CLASS}>
          Configuration for this workspace.
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  ),
};
