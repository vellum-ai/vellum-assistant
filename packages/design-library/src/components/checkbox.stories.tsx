import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";

import { Checkbox } from "./checkbox";

const meta: Meta<typeof Checkbox> = {
  title: "Components/Checkbox",
  component: Checkbox,
  args: {
    checked: false,
    label: "Email me about product updates",
    disabled: false,
  },
  argTypes: {
    checked: {
      control: "select",
      options: [false, true, "indeterminate"],
    },
  },
  // Controlled component: drive `checked` from the arg and write it back on
  // change so the Controls panel and the canvas stay in sync (Storybook's
  // recommended pattern for controlled inputs).
  render: function Render(args) {
    const [{ checked }, updateArgs] = useArgs();
    return (
      <Checkbox
        {...args}
        checked={checked}
        onCheckedChange={(next) => updateArgs({ checked: next })}
      />
    );
  },
};

export default meta;

type Story = StoryObj<typeof Checkbox>;

/** Arg-driven: toggle `checked` and `disabled`, edit the label, in Controls. */
export const Default: Story = {
  args: { checked: true },
};

/** A label plus secondary helper copy. */
export const WithHelperText: Story = {
  args: {
    label: "Enable notifications",
    helperText: "We'll only ping you for mentions and direct messages.",
  },
};

/** Tri-state: `"indeterminate"` renders the dash; clicking resolves it. */
export const Indeterminate: Story = {
  args: { checked: "indeterminate", label: "Select all" },
};

/** Every rendered state at a glance (static — no shared control). */
export const AllStates: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <Checkbox checked={false} label="Unchecked" onCheckedChange={() => {}} />
      <Checkbox checked label="Checked" onCheckedChange={() => {}} />
      <Checkbox
        checked="indeterminate"
        label="Indeterminate"
        onCheckedChange={() => {}}
      />
      <Checkbox
        checked={false}
        label="Disabled unchecked"
        disabled
        onCheckedChange={() => {}}
      />
      <Checkbox
        checked
        label="Disabled checked"
        disabled
        onCheckedChange={() => {}}
      />
    </div>
  ),
};

/** No label — a bare box driven only by `aria-label`. */
export const NoLabel: Story = {
  args: { label: undefined, "aria-label": "Standalone checkbox" },
};
