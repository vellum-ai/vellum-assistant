import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";

import { Disclosure, type DisclosureRootProps } from "./disclosure";
import { Input } from "./input";

const meta: Meta<DisclosureRootProps> = {
  title: "Components/Disclosure",
  component: Disclosure.Root,
  args: { defaultOpen: false, disabled: false },
  argTypes: {
    open: { control: "boolean" },
    defaultOpen: { control: "boolean" },
    disabled: { control: "boolean" },
    onOpenChange: { control: false },
  },
  decorators: [
    (Story) => (
      <div style={{ width: 360 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<DisclosureRootProps>;

function AdvancedFields() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Input placeholder="Display name" aria-label="Display name" />
      <Input placeholder="Base URL" aria-label="Base URL" />
    </div>
  );
}

export const Default: Story = {
  render: (args) => (
    <Disclosure.Root {...args}>
      <Disclosure.Trigger>Advanced</Disclosure.Trigger>
      <Disclosure.Content className="mt-2">
        <AdvancedFields />
      </Disclosure.Content>
    </Disclosure.Root>
  ),
};

export const DefaultOpen: Story = {
  ...Default,
  args: { defaultOpen: true },
};

/** `open` driven from the Controls panel and written back on toggle. */
export const Controlled: Story = {
  args: { open: true },
  render: function Render(args) {
    const [{ open }, updateArgs] = useArgs<DisclosureRootProps>();
    return (
      <Disclosure.Root
        {...args}
        open={open}
        onOpenChange={(next) => updateArgs({ open: next })}
      >
        <Disclosure.Trigger>Advanced</Disclosure.Trigger>
        <Disclosure.Content className="mt-2">
          <AdvancedFields />
        </Disclosure.Content>
      </Disclosure.Root>
    );
  },
};

export const MediumTrigger: Story = {
  render: (args) => (
    <Disclosure.Root {...args}>
      <Disclosure.Trigger size="medium">Advanced</Disclosure.Trigger>
      <Disclosure.Content className="mt-4">
        <AdvancedFields />
      </Disclosure.Content>
    </Disclosure.Root>
  ),
};

/**
 * Type into a field, close, and open again: the text is still there. Without
 * `keepMounted` the region unmounts on close and the inputs reset.
 */
export const KeepMounted: Story = {
  args: { defaultOpen: true },
  render: (args) => (
    <Disclosure.Root {...args}>
      <Disclosure.Trigger>Advanced</Disclosure.Trigger>
      <Disclosure.Content keepMounted className="mt-2">
        <AdvancedFields />
      </Disclosure.Content>
    </Disclosure.Root>
  ),
};

export const Disabled: Story = {
  ...Default,
  args: { disabled: true },
};

export const FullWidthTrigger: Story = {
  render: (args) => (
    <Disclosure.Root {...args}>
      <Disclosure.Trigger fullWidth>Advanced</Disclosure.Trigger>
      <Disclosure.Content className="mt-2">
        <AdvancedFields />
      </Disclosure.Content>
    </Disclosure.Root>
  ),
};
