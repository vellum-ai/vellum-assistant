/**
 * The input-modalities table inside the profile editor for a free-text model:
 * one row per modality (image, audio) with an Enabled toggle, a Supported
 * toggle that unlocks once the row is enabled, and a line under the label
 * saying whether the modality reaches the wire. The toggles are live here: the
 * render draws the value and the disclosure from the args and writes each
 * change back through `useArgs`, so the canvas and the Controls panel stay in
 * step. The stories cover the free-text defaults with every row
 * off, a mixed configuration, the read-only rendering a managed profile gets,
 * and the collapsible layout the modal uses, closed and open.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";
import { fn } from "storybook/test";

import {
  ProfileModalitiesSection,
  type ProfileModalitiesSectionProps,
} from "@/domains/settings/ai/profile-modalities-section";

const meta = {
  title: "Settings/AI/ProfileModalitiesSection",
  component: ProfileModalitiesSection,
  parameters: {
    layout: "centered",
  },
  args: {
    value: {},
    onChange: fn(),
    onExpandedChange: fn(),
    isReadOnly: false,
    expanded: true,
    collapsible: false,
  },
  render: function Render(args) {
    const [{ value, expanded }, updateArgs] =
      useArgs<ProfileModalitiesSectionProps>();
    return (
      <ProfileModalitiesSection
        {...args}
        value={value}
        expanded={expanded}
        onChange={(next) => {
          updateArgs({ value: next });
          args.onChange(next);
        }}
        onExpandedChange={(open) => {
          updateArgs({ expanded: open });
          args.onExpandedChange?.(open);
        }}
      />
    );
  },
  decorators: [
    (Story) => (
      <div className="w-[420px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProfileModalitiesSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The free-text defaults: both rows off, so each Supported toggle is locked
 * and the label line says the modality is not sent.
 */
export const Defaults: Story = {};

/**
 * Image enabled and supported, audio enabled but marked unsupported, which is
 * the one combination where an enabled row still says it is not sent.
 */
export const Mixed: Story = {
  args: {
    value: {
      image: { enabled: true, supported: true },
      audio: { enabled: true, supported: false },
    },
  },
};

/** A managed profile: the same rows with every toggle disabled. */
export const ReadOnly: Story = {
  args: {
    ...Mixed.args,
    isReadOnly: true,
  },
};

/** The modal's layout starts folded behind a disclosure button. */
export const Collapsible: Story = {
  args: {
    collapsible: true,
    expanded: false,
  },
};

/** The same disclosure opened, with the table below it. */
export const CollapsibleExpanded: Story = {
  args: {
    ...Mixed.args,
    collapsible: true,
    expanded: true,
  },
};
