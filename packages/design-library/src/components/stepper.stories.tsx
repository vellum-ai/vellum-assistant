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

// Gated wizard: completed steps navigate back, the active step is underlined,
// and upcoming steps are muted and locked.
function GatedStepper() {
  const [current, setCurrent] = useState(1);
  return (
    <Stepper
      aria-label="Setup steps"
      steps={STEPS}
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
    steps: STEPS,
    current: 0,
    onStepSelect: () => {},
  },
};

// While submitting, navigation is disabled — but completed steps keep their
// visited styling, staying visually distinct from the muted upcoming steps.
export const Submitting: Story = {
  args: {
    "aria-label": "Setup steps",
    steps: STEPS,
    current: 1,
    onStepSelect: () => {},
    disabled: true,
  },
};
