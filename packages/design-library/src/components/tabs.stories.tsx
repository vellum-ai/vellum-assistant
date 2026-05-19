import type { Meta, StoryObj } from "@storybook/react-vite";

import { Tabs } from "./tabs.js";

const meta: Meta = {
  title: "Components/Tabs",
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <Tabs.Root defaultValue="tab1" className="w-96">
      <Tabs.List>
        <Tabs.Trigger value="tab1">General</Tabs.Trigger>
        <Tabs.Trigger value="tab2">Settings</Tabs.Trigger>
        <Tabs.Trigger value="tab3">Advanced</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Panel value="tab1">
        <p className="p-4 text-body-medium-default">General settings content</p>
      </Tabs.Panel>
      <Tabs.Panel value="tab2">
        <p className="p-4 text-body-medium-default">Settings panel content</p>
      </Tabs.Panel>
      <Tabs.Panel value="tab3">
        <p className="p-4 text-body-medium-default">Advanced options content</p>
      </Tabs.Panel>
    </Tabs.Root>
  ),
};
