import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Toggle } from "./toggle.js";

const meta: Meta = {
  title: "Components/Toggle",
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj;

function ToggleDemo({ label, helperText, disabled }: { label?: string; helperText?: string; disabled?: boolean }) {
  const [checked, setChecked] = useState(false);
  return <Toggle checked={checked} onChange={setChecked} label={label} helperText={helperText} disabled={disabled} />;
}

export const Default: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <ToggleDemo />
      <ToggleDemo label="Notifications" />
      <ToggleDemo label="Dark mode" helperText="Switch to dark theme" />
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <Toggle checked={false} onChange={() => {}} disabled label="Disabled off" />
      <Toggle checked={true} onChange={() => {}} disabled label="Disabled on" />
    </div>
  ),
};
