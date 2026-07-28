import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";

import { Radio, RadioGroup } from "./radio";

const meta: Meta<typeof RadioGroup> = {
  title: "Components/Radio",
  component: RadioGroup,
  args: {
    value: "pro",
    orientation: "vertical",
    disabled: false,
  },
  argTypes: {
    orientation: {
      control: "inline-radio",
      options: ["vertical", "horizontal"],
    },
    value: {
      control: "inline-radio",
      options: ["free", "pro", "team"],
    },
  },
  // The group's `value` is controlled; drive it from the arg and write it back
  // so the Controls panel and canvas stay in sync. Options are fixed children.
  render: function Render(args) {
    const [{ value }, updateArgs] = useArgs();
    return (
      <RadioGroup
        {...args}
        value={value}
        onValueChange={(next) => updateArgs({ value: next })}
        aria-label="Plan"
      >
        <Radio value="free" label="Free" />
        <Radio value="pro" label="Pro" />
        <Radio value="team" label="Team" />
      </RadioGroup>
    );
  },
};

export default meta;

type Story = StoryObj<typeof RadioGroup>;

/** Arg-driven: change the selection, orientation, or disabled in Controls. */
export const Default: Story = {};

/** Horizontal orientation wraps options into a row. */
export const Horizontal: Story = {
  args: { orientation: "horizontal" },
};

/** The whole group disabled. */
export const Disabled: Story = {
  args: { disabled: true },
};

/**
 * Options with secondary helper copy, and one option disabled individually.
 * Fixed composition, so Controls are disabled here.
 */
export const WithHelperText: Story = {
  parameters: { controls: { disable: true } },
  render: function Render() {
    const [{ value }, updateArgs] = useArgs();
    return (
      <RadioGroup
        value={typeof value === "string" ? value : "free"}
        onValueChange={(next) => updateArgs({ value: next })}
        aria-label="Plan"
      >
        <Radio
          value="free"
          label="Free"
          helperText="For personal projects and evaluation."
        />
        <Radio
          value="pro"
          label="Pro"
          helperText="For individuals shipping to production."
        />
        <Radio
          value="team"
          label="Team"
          helperText="Contact sales to enable."
          disabled
        />
      </RadioGroup>
    );
  },
};
