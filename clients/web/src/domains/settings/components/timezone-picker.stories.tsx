import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";

import { TimezonePicker } from "./timezone-picker";

/**
 * The "Closest city" row of Settings → General: a search field over the IANA
 * zone list, with the resolved zone name shown underneath.
 *
 * The list is a combobox. Focus stays in the field, ArrowDown/ArrowUp move the
 * highlight, Enter commits it, Escape closes. Try it from the keyboard here:
 * the story owns `value`, so the picked zone shows up in the row below.
 */
const meta: Meta<typeof TimezonePicker> = {
  title: "Settings/TimezonePicker",
  component: TimezonePicker,
  args: {
    value: "America/New_York",
  },
  argTypes: {
    onChange: { control: false },
  },
  decorators: [
    (Story) => (
      <div className="w-[560px] p-6">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof TimezonePicker>;

export const Default: Story = {
  render: function Render(args) {
    const [{ value }, updateArgs] = useArgs<{ value: string }>();
    return (
      <TimezonePicker
        {...args}
        value={value}
        onChange={(next) => updateArgs({ value: next })}
      />
    );
  },
};

/** No zone stored yet: the field prompts, and the row below reads "Not set". */
export const Unset: Story = {
  ...Default,
  args: { value: "" },
};
