import { useState } from "react";
import { Sun, Moon, Monitor } from "lucide-react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { SegmentControl, type SegmentControlItem } from "./segment-control.js";

const meta: Meta = {
  title: "Components/SegmentControl",
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj;

const textItems: SegmentControlItem<"daily" | "weekly" | "monthly">[] = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

function TextDemo() {
  const [value, setValue] = useState<"daily" | "weekly" | "monthly">("weekly");
  return <SegmentControl items={textItems} value={value} onChange={setValue} ariaLabel="Frequency" className="w-80" />;
}

export const Default: Story = {
  render: () => <TextDemo />,
};

const iconItems: SegmentControlItem<"light" | "dark" | "system">[] = [
  { value: "light", label: "Light", icon: <Sun className="h-4 w-4" /> },
  { value: "dark", label: "Dark", icon: <Moon className="h-4 w-4" /> },
  { value: "system", label: "System", icon: <Monitor className="h-4 w-4" /> },
];

function IconDemo() {
  const [value, setValue] = useState<"light" | "dark" | "system">("system");
  return <SegmentControl items={iconItems} value={value} onChange={setValue} ariaLabel="Theme" iconOnly />;
}

export const IconOnly: Story = {
  render: () => <IconDemo />,
};

const withDisabled: SegmentControlItem<"a" | "b" | "c">[] = [
  { value: "a", label: "Enabled" },
  { value: "b", label: "Disabled", disabled: true },
  { value: "c", label: "Also enabled" },
];

function DisabledDemo() {
  const [value, setValue] = useState<"a" | "b" | "c">("a");
  return <SegmentControl items={withDisabled} value={value} onChange={setValue} ariaLabel="With disabled" className="w-80" />;
}

export const WithDisabledItem: Story = {
  render: () => <DisabledDemo />,
};
