/**
 * Visual reference for `IconTile`.
 *
 * Two surfaces share this primitive and want different geometry: the
 * collapsed sidebar rail is a column of circles, and the group-icon picker is
 * a grid of square tiles. `shape` is the only thing that differs, so the
 * stories put the two side by side.
 *
 * The rail stories render a real `GroupIndicatorDot`, since where that dot
 * lands on a circle is the thing worth looking at.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { Clock, Folder, MessageSquare, Pin, Star } from "lucide-react";

import {
  GroupIndicatorDot,
  type GroupIndicatorState,
} from "@/domains/chat/components/collapsed-group-icon";
import { IconTile } from "@/domains/chat/components/icon-tile";

const meta: Meta<typeof IconTile> = {
  title: "Chat/IconTile",
  component: IconTile,
  args: { label: "Pinned", shape: "square" },
  argTypes: {
    shape: { control: "inline-radio", options: ["square", "round"] },
    label: { control: "text" },
    disabled: { control: "boolean" },
    side: { control: false },
    children: { control: false },
    ref: { control: false },
  },
  globals: { viewport: { value: "sbDesktop", isRotated: false } },
  parameters: {
    layout: "padded",
    viewport: {
      options: {
        sbDesktop: {
          name: "Desktop",
          styles: { width: "1280px", height: "760px" },
          type: "desktop",
        },
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof IconTile>;

/** Arg-driven: flip `shape` and `disabled` from the Controls panel. */
export const Default: Story = {
  render: (args) => (
    <IconTile {...args}>
      <Pin size={14} />
    </IconTile>
  ),
};

/** The two shapes, so the picker and the rail can be compared directly. */
export const Shapes: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex items-center gap-3">
      <IconTile label="Square" shape="square">
        <Folder size={14} />
      </IconTile>
      <IconTile label="Round" shape="round">
        <Folder size={14} />
      </IconTile>
    </div>
  ),
};

/**
 * The collapsed rail: one circle per section, each carrying the same
 * indicator the expanded header shows. The last tile is a section with no
 * conversations, which keeps its slot and drops only its affordances.
 */
export const CollapsedRail: Story = {
  parameters: { controls: { disable: true } },
  render: () => {
    const tiles: Array<{
      label: string;
      icon: typeof Pin;
      state: GroupIndicatorState;
      disabled?: boolean;
    }> = [
      { label: "Pinned", icon: Pin, state: null },
      { label: "Car Chat", icon: Folder, state: "unread" },
      { label: "Chats", icon: MessageSquare, state: "attention" },
      { label: "Scheduled", icon: Clock, state: "processing" },
      { label: "No conversations", icon: Star, state: null, disabled: true },
    ];
    return (
      <div className="flex w-[54px] flex-col items-center gap-2 rounded-lg bg-[var(--surface-overlay)] py-3">
        {tiles.map(({ label, icon: Icon, state, disabled }) => (
          <IconTile
            key={label}
            label={label}
            shape="round"
            side="right"
            disabled={disabled}
          >
            <Icon size={14} />
            <GroupIndicatorDot
              state={state}
              className="absolute right-0 top-0 border-2 border-[var(--surface-overlay)]"
            />
          </IconTile>
        ))}
      </div>
    );
  },
};
