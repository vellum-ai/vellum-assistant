import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";

import { AdvisorProfileRow } from "@/domains/settings/ai/advisor-profile-row";

// Mirrors what `visibleProfilesForPicker` + `profilePickerLabel` produce in
// the Action Overrides panel, including the "(Disabled)" suffix the picker
// appends when the current selection is a disabled profile.
const PROFILE_OPTIONS = [
  { value: "quality-optimized", label: "Quality" },
  { value: "balanced", label: "Balanced" },
  { value: "speed-tier", label: "Speed" },
  { value: "my-custom", label: "My Custom" },
];

const meta: Meta<typeof AdvisorProfileRow> = {
  title: "Settings/AI/AdvisorProfileRow",
  component: AdvisorProfileRow,
  args: {
    value: "quality-optimized",
    profileOptions: PROFILE_OPTIONS,
    disabled: false,
  },
  argTypes: {
    onChange: { control: false },
  },
  // The row is controlled, so a pick writes back to the `value` arg; a story
  // that passed a bare `value` would render a picker that won't move.
  render: function Render(args) {
    const [{ value }, updateArgs] = useArgs<{ value: string }>();
    return (
      <AdvisorProfileRow
        {...args}
        value={value}
        onChange={(next) => updateArgs({ value: next })}
      />
    );
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 520, padding: 24 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof AdvisorProfileRow>;

/** The common case: `llm.advisorProfile` is seeded, so a profile is selected. */
export const Default: Story = {};

/**
 * No selection. Only reachable between deleting the profile the advisor
 * pointed at (which clears the reference so no dangling name survives) and
 * the next daemon boot, whose seeding re-fills the key.
 */
export const NoSelection: Story = {
  args: { value: "" },
};

/**
 * The current selection is a disabled profile. The picker keeps it visible
 * (and suffixed) so the trigger has a label and there's a way back out.
 */
export const DisabledProfileSelected: Story = {
  args: {
    value: "speed-tier",
    profileOptions: [
      { value: "quality-optimized", label: "Quality" },
      { value: "balanced", label: "Balanced" },
      { value: "speed-tier", label: "Speed (Disabled)" },
    ],
  },
};

/** Held inert while the panel's Save is in flight. */
export const Saving: Story = {
  args: { value: "balanced", disabled: true },
};
