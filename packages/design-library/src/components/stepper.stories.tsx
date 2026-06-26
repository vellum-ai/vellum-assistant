import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { Stepper } from "./stepper";

const meta: Meta<typeof Stepper> = {
  title: "Components/Stepper",
  component: Stepper,
};

export default meta;

type Story = StoryObj<typeof Stepper>;

const STEPS = [
  { id: "create", label: "1. Create App" },
  { id: "token", label: "2. Generate App Token" },
  { id: "install", label: "3. Install App" },
];

// Gated wizard: the active step is underlined, completed steps navigate back,
// and future steps are disabled.
function GatedStepper() {
  const [current, setCurrent] = useState(1);
  return (
    <Stepper
      aria-label="Setup steps"
      steps={STEPS.map((step, i) => ({ ...step, disabled: i > current }))}
      current={current}
      onStepSelect={setCurrent}
    />
  );
}

export const Gated: Story = {
  render: () => <GatedStepper />,
};

export const FirstStep: Story = {
  args: {
    "aria-label": "Setup steps",
    steps: STEPS.map((step, i) => ({ ...step, disabled: i > 0 })),
    current: 0,
    onStepSelect: () => {},
  },
};
