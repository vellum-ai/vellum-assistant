import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";

import { Slider } from "./slider";

const meta: Meta<typeof Slider> = {
  title: "Components/Slider",
  component: Slider,
  args: {
    value: 40,
    label: "Volume",
    min: 0,
    max: 100,
    step: 1,
    showValue: true,
    disabled: false,
  },
  // Controlled: drive `value` from the arg and write it back on change so the
  // Controls panel and canvas stay in sync.
  render: function Render(args) {
    const [{ value }, updateArgs] = useArgs();
    return (
      <div style={{ width: 320 }}>
        <Slider
          {...args}
          value={value}
          onValueChange={(next) => updateArgs({ value: next })}
        />
      </div>
    );
  },
};

export default meta;

type Story = StoryObj<typeof Slider>;

/** Arg-driven: drag the thumb or edit min/max/step in Controls. */
export const Default: Story = {};

/** Two thumbs bound a range; the value renders as `low – high`. */
export const Range: Story = {
  args: { value: [20, 70], label: "Price range" },
};

/** A custom `formatValue` and a coarser step. */
export const CustomFormatAndStep: Story = {
  args: {
    value: 50,
    label: "Opacity",
    step: 5,
    formatValue: (v) => `${v}%`,
  },
};

/** No label or readout — a bare track driven by `aria-label`. */
export const Bare: Story = {
  args: {
    value: 60,
    label: undefined,
    showValue: false,
    "aria-label": "Brightness",
  },
};

/** Disabled slider. */
export const Disabled: Story = {
  args: { disabled: true },
};
