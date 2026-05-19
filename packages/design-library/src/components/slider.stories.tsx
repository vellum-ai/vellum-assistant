import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Slider, type SliderValue } from "./slider.js";

const meta: Meta = {
  title: "Components/Slider",
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj;

function SingleDemo() {
  const [value, setValue] = useState<SliderValue>(50);
  return (
    <div className="w-80">
      <Slider value={value} onValueChange={setValue} label="Volume" min={0} max={100} step={1} showValue />
    </div>
  );
}

export const Default: Story = {
  render: () => <SingleDemo />,
};

function RangeDemo() {
  const [value, setValue] = useState<SliderValue>([20, 80]);
  return (
    <div className="w-80">
      <Slider value={value} onValueChange={setValue} label="Price range" min={0} max={100} step={5} showValue />
    </div>
  );
}

export const Range: Story = {
  render: () => <RangeDemo />,
};

export const Disabled: Story = {
  render: () => (
    <div className="w-80">
      <Slider value={30} onValueChange={() => {}} label="Disabled" min={0} max={100} disabled showValue />
    </div>
  ),
};
