import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { RadioGroup, Radio } from "./radio.js";

const meta: Meta = {
  title: "Components/Radio",
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj;

function RadioDemo() {
  const [value, setValue] = useState("option1");
  return (
    <RadioGroup value={value} onValueChange={setValue} aria-label="Choose an option">
      <Radio value="option1" label="Option 1" />
      <Radio value="option2" label="Option 2" />
      <Radio value="option3" label="Option 3" />
    </RadioGroup>
  );
}

export const Default: Story = {
  render: () => <RadioDemo />,
};

export const Horizontal: Story = {
  render: () => {
    const [value, setValue] = useState("a");
    return (
      <RadioGroup value={value} onValueChange={setValue} aria-label="Direction" orientation="horizontal">
        <Radio value="a" label="Alpha" />
        <Radio value="b" label="Beta" />
        <Radio value="c" label="Gamma" />
      </RadioGroup>
    );
  },
};

export const WithHelperText: Story = {
  render: () => {
    const [value, setValue] = useState("free");
    return (
      <RadioGroup value={value} onValueChange={setValue} aria-label="Plan">
        <Radio value="free" label="Free" helperText="Basic features" />
        <Radio value="pro" label="Pro" helperText="All features included" />
        <Radio value="enterprise" label="Enterprise" helperText="Custom pricing" />
      </RadioGroup>
    );
  },
};
