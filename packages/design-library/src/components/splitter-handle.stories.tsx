import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { SplitterHandle } from "./splitter-handle";

const MIN = 120;
const MAX = 480;

const meta: Meta<typeof SplitterHandle> = {
  title: "Components/SplitterHandle",
  component: SplitterHandle,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The interactive divider between two panes. Tab to it, then use " +
          "Left/Right to nudge (hold Shift for a coarser step) and Home/End " +
          "to jump to the minimum and maximum. Implements the APG window " +
          "splitter pattern: https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/",
      },
    },
  },
  args: {
    min: MIN,
    max: MAX,
    label: "Resize panels",
    invert: false,
    step: 16,
  },
  argTypes: {
    value: { control: false },
    onValueChange: { control: false },
    onValueCommit: { control: false },
    onDragStart: { control: false },
    onDragEnd: { control: false },
    children: { control: false },
    step: { control: { type: "number" } },
  },
  decorators: [
    (Story) => (
      <div style={{ height: "320px", width: "100%" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof SplitterHandle>;

function Pane({ label, bg }: { label: string; bg: string }) {
  return (
    <div
      className="flex h-full items-center justify-center px-4 text-center"
      style={{ backgroundColor: bg }}
    >
      <span className="text-sm font-medium text-[color:var(--content-default)]">
        {label}
      </span>
    </div>
  );
}

/**
 * A left pane sized by the handle. Moving the handle right widens it, so
 * `invert` stays false. The live `aria-valuenow` is echoed under the panes so
 * a reviewer can watch it track the keyboard without a screen reader.
 */
export const Default: Story = {
  render: function Render(args) {
    const [width, setWidth] = useState(240);
    const [committed, setCommitted] = useState(240);
    // The handle reports what was asked for; clamping is the caller's job.
    const clamp = (next: number) => Math.min(MAX, Math.max(MIN, next));
    return (
      <div className="flex h-full w-full flex-col">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div
            id="splitter-story-left"
            className="h-full shrink-0"
            style={{ width }}
          >
            <Pane label="Left pane" bg="var(--surface-base)" />
          </div>
          <SplitterHandle
            {...args}
            value={width}
            controls="splitter-story-left"
            onValueChange={(next) => setWidth(clamp(next))}
            onValueCommit={(next) => setCommitted(clamp(next))}
            className="group relative z-10 flex h-full w-2 shrink-0 items-center justify-center"
          >
            <div className="h-full w-px bg-[var(--border-base)]" />
            <div className="absolute h-8 w-1 rounded-full bg-[var(--content-tertiary)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
          </SplitterHandle>
          <div className="h-full min-w-0 flex-1">
            <Pane label="Right pane" bg="var(--surface-lift)" />
          </div>
        </div>
        <p className="p-2 text-xs text-[color:var(--content-tertiary)]">
          Tab to the divider, then Left/Right (Shift for a coarse step) or
          Home/End. aria-valuenow: {Math.round(width)} (min {args.min}, max{" "}
          {args.max}). Last committed: {Math.round(committed)}.
        </p>
      </div>
    );
  },
};

/**
 * The same handle sizing the pane on its *right*, as a side drawer does.
 * `invert` keeps the arrow keys following the divider rather than the pane, so
 * ArrowRight still moves the divider rightward and the drawer gets narrower.
 */
export const RightAnchoredPane: Story = {
  args: { invert: true, label: "Resize side panel" },
  render: function Render(args) {
    const [width, setWidth] = useState(240);
    const clamp = (next: number) => Math.min(MAX, Math.max(MIN, next));
    return (
      <div className="flex h-full w-full flex-col">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="h-full min-w-0 flex-1">
            <Pane label="Fills the rest" bg="var(--surface-lift)" />
          </div>
          <SplitterHandle
            {...args}
            value={width}
            controls="splitter-story-drawer"
            onValueChange={(next) => setWidth(clamp(next))}
            className="group relative z-10 flex h-full w-2 shrink-0 items-center justify-center"
          >
            <div className="h-full w-px bg-[var(--border-base)]" />
            <div className="absolute h-8 w-1 rounded-full bg-[var(--content-tertiary)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
          </SplitterHandle>
          <div
            id="splitter-story-drawer"
            className="h-full shrink-0"
            style={{ width }}
          >
            <Pane label="Drawer" bg="var(--surface-base)" />
          </div>
        </div>
        <p className="p-2 text-xs text-[color:var(--content-tertiary)]">
          ArrowRight moves the divider right, which narrows the drawer.
          aria-valuenow: {Math.round(width)}.
        </p>
      </div>
    );
  },
};
