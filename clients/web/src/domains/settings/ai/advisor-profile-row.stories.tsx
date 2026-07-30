import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

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

/**
 * Interactive wrapper. The row is controlled, so a story that passes a bare
 * `value` renders a picker that won't move when clicked.
 */
function Controlled(props: {
  initial: string;
  options?: { value: string; label: string }[];
  disabled?: boolean;
}) {
  const [value, setValue] = useState(props.initial);
  return (
    <AdvisorProfileRow
      value={value}
      profileOptions={props.options ?? PROFILE_OPTIONS}
      disabled={props.disabled}
      onChange={setValue}
    />
  );
}

/** The common case: `llm.advisorProfile` is seeded, so a profile is selected. */
export const Default: Story = {
  render: () => <Controlled initial="quality-optimized" />,
};

/**
 * No selection. Only reachable between deleting the profile the advisor
 * pointed at (which clears the reference so no dangling name survives) and
 * the next daemon boot, whose seeding re-fills the key.
 */
export const NoSelection: Story = {
  render: () => <Controlled initial="" />,
};

/**
 * The current selection is a disabled profile. The picker keeps it visible
 * (and suffixed) so the trigger has a label and there's a way back out.
 */
export const DisabledProfileSelected: Story = {
  render: () => (
    <Controlled
      initial="speed-tier"
      options={[
        { value: "quality-optimized", label: "Quality" },
        { value: "balanced", label: "Balanced" },
        { value: "speed-tier", label: "Speed (Disabled)" },
      ]}
    />
  ),
};

/** Held inert while the panel's Save is in flight. */
export const Saving: Story = {
  render: () => <Controlled initial="balanced" disabled />,
};
