import type { Meta, StoryObj } from "@storybook/react-vite";

import { WorkspacePanes } from "./workspace-panes";

/**
 * The workspace's two surfaces, arranged. The arrangement is the only input
 * that changes what is drawn, so each story is the same pair under a
 * different one.
 *
 * `"full"` and `"single"` draw the same picture on purpose: a collapsed
 * secondary is still open, and is what the primary would give the room back
 * to. The difference lives in the workspace's state rather than on screen,
 * which is why one story covers both.
 */
const meta: Meta<typeof WorkspacePanes> = {
  title: "Chat/WorkspacePanes",
  component: WorkspacePanes,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Side by side puts the secondary on the left and gives the primary " +
          "the sized pane on the right, which is where an app sits beside a " +
          "conversation. Drag the divider, or Tab to it and use the arrow keys.",
      },
    },
  },
  argTypes: {
    primary: { control: false },
    secondary: { control: false },
  },
  decorators: [
    (Story) => (
      <div style={{ height: "520px", width: "100%" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof WorkspacePanes>;

function Surface({
  label,
  note,
  bg,
}: {
  label: string;
  note: string;
  bg: string;
}) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center"
      style={{ backgroundColor: bg }}
    >
      <span className="text-sm font-medium text-[color:var(--content-emphasised)]">
        {label}
      </span>
      <span className="text-xs text-[color:var(--content-tertiary)]">
        {note}
      </span>
    </div>
  );
}

const APP = (
  <Surface
    label="Support Monitor"
    note="the primary, the surface being worked on"
    bg="var(--surface-lift)"
  />
);

const CONVERSATION = (
  <Surface
    label="Weekly numbers"
    note="the secondary, sharing the room"
    bg="var(--surface-base)"
  />
);

/** An app beside the conversation it is being changed from. */
export const SideBySide: Story = {
  args: { presentation: "side", primary: APP, secondary: CONVERSATION },
};

/**
 * One surface with the width. The secondary is passed and deliberately not
 * drawn, which is what `"full"` means: open, collapsed, one click from
 * returning.
 */
export const FullWidthOverACollapsedSecondary: Story = {
  args: { presentation: "full", primary: APP, secondary: CONVERSATION },
};

/** Nothing beside it at all, which is the same picture and a different state. */
export const OneSurfaceAlone: Story = {
  args: {
    presentation: "single",
    primary: (
      <Surface
        label="Weekly numbers"
        note="the primary, with nothing beside it"
        bg="var(--surface-base)"
      />
    ),
  },
};
