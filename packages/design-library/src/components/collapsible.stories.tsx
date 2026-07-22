import { ChevronDown } from "lucide-react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Collapsible } from "./collapsible";

const meta: Meta<typeof Collapsible.Root> = {
  title: "Components/Collapsible",
  component: Collapsible.Root,
};

export default meta;

type Story = StoryObj<typeof Collapsible.Root>;

const SECTIONS = [
  {
    value: "install",
    title: "Installation",
    body: "Run bun install at the workspace root; every package resolves from the single lockfile.",
  },
  {
    value: "config",
    title: "Configuration",
    body: "Settings live in the workspace directory and sync across every connected client.",
  },
  {
    value: "usage",
    title: "Usage",
    body: "Open the app, pick an assistant, and start a conversation.",
  },
];

// Collapsible ships structure + animation only; trigger styling (chevron,
// padding, dividers) is the consumer's responsibility, so the stories supply
// it — mirroring how a real feature would dress the primitive.
function Section({
  value,
  title,
  body,
}: {
  value: string;
  title: string;
  body: string;
}) {
  return (
    <Collapsible.Item
      value={value}
      className="border-b border-[var(--border-base)]"
    >
      <Collapsible.Trigger className="group justify-between py-3 text-body-medium-default text-[var(--content-default)]">
        {title}
        <ChevronDown className="h-4 w-4 text-[var(--content-tertiary)] transition-transform group-data-[state=open]:rotate-180" />
      </Collapsible.Trigger>
      <Collapsible.Content>
        <p className="pb-3 text-body-medium-lighter text-[var(--content-secondary)]">
          {body}
        </p>
      </Collapsible.Content>
    </Collapsible.Item>
  );
}

/**
 * Single-open accordion: opening one section closes the others. `collapsible`
 * lets the open section close again. The render function composes the parts
 * and spreads the Root args (`type`, `defaultValue`).
 */
export const Default: Story = {
  args: { type: "single", defaultValue: "install", collapsible: true },
  render: (args) => (
    <div style={{ width: 440 }}>
      <Collapsible.Root {...args}>
        {SECTIONS.map((s) => (
          <Section key={s.value} {...s} />
        ))}
      </Collapsible.Root>
    </div>
  ),
};

/** `type="multiple"` lets several sections stay open at once. */
export const Multiple: Story = {
  args: { type: "multiple", defaultValue: ["install", "usage"] },
  render: (args) => (
    <div style={{ width: 440 }}>
      <Collapsible.Root {...args}>
        {SECTIONS.map((s) => (
          <Section key={s.value} {...s} />
        ))}
      </Collapsible.Root>
    </div>
  ),
};
