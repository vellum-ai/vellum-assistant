import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Checkbox, type CheckboxState } from "./checkbox.js";

const meta: Meta = {
  title: "Components/Checkbox",
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj;

function CheckboxDemo({ label, helperText }: { label?: string; helperText?: string }) {
  const [checked, setChecked] = useState<CheckboxState>(false);
  return <Checkbox checked={checked} onCheckedChange={setChecked} label={label} helperText={helperText} />;
}

export const Default: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <CheckboxDemo />
      <CheckboxDemo label="Accept terms" />
      <CheckboxDemo label="Subscribe" helperText="Get notified about updates" />
    </div>
  ),
};

export const States: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <Checkbox checked={false} label="Unchecked" aria-label="unchecked" />
      <Checkbox checked={true} label="Checked" aria-label="checked" />
      <Checkbox checked="indeterminate" label="Indeterminate" aria-label="indeterminate" />
      <Checkbox checked={false} label="Disabled" disabled aria-label="disabled" />
      <Checkbox checked={true} label="Disabled checked" disabled aria-label="disabled checked" />
    </div>
  ),
};
