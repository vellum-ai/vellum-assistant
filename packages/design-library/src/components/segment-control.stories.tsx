import { Monitor, Moon, Sun } from "lucide-react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";
import { expect, screen, userEvent, waitFor } from "storybook/test";

import { SegmentControl, type SegmentControlItem } from "./segment-control";

/**
 * Every value any story's items offer, as one union. A call site instantiates
 * `SegmentControl<T>` with its own domain union, and these stories keep that
 * property rather than widening to `string`: a `value` arg that matches no
 * item is then a type error, not a control that silently renders nothing
 * active.
 */
type DemoValue =
  | "small"
  | "medium"
  | "large"
  | "system"
  | "light"
  | "dark"
  | "daily"
  | "weekly"
  | "monthly";

const SIZE_ITEMS: SegmentControlItem<DemoValue>[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];

const THEME_ITEMS: SegmentControlItem<DemoValue>[] = [
  { value: "system", label: "System", icon: <Monitor className="h-4 w-4" /> },
  { value: "light", label: "Light", icon: <Sun className="h-4 w-4" /> },
  { value: "dark", label: "Dark", icon: <Moon className="h-4 w-4" /> },
];

const meta: Meta<typeof SegmentControl<DemoValue>> = {
  title: "Components/SegmentControl",
  component: SegmentControl,
  args: {
    items: SIZE_ITEMS,
    value: "medium",
    ariaLabel: "Size",
    iconOnly: false,
    showTooltips: true,
  },
  argTypes: {
    items: { control: false },
    onChange: { control: false },
    value: {
      control: "select",
      options: [...SIZE_ITEMS.map((item) => item.value), null],
    },
    iconOnly: { control: "boolean" },
    showTooltips: { control: "boolean" },
    className: { control: false },
  },
  // Controlled: drive `value` from the arg and write it back on change so the
  // Controls panel and canvas stay in sync.
  render: function Render(args) {
    const [{ value }, updateArgs] = useArgs<{ value: DemoValue | null }>();
    return (
      <SegmentControl
        {...args}
        value={value}
        onChange={(next) => updateArgs({ value: next })}
      />
    );
  },
  decorators: [
    (Story) => (
      // Text-mode segments are `w-full`, so they need a bounded parent to show
      // the equal-thirds split the app gets from a settings column. `iconOnly`
      // is intrinsically sized and ignores this.
      <div style={{ maxWidth: 360 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof SegmentControl<DemoValue>>;

/**
 * Arg-driven text mode: pick the selected segment in Controls and the canvas
 * follows, the way a settings row drives the control from its own state.
 */
export const Default: Story = {};

/**
 * Icon-only mode: each segment renders its `icon` alone and promotes `label`
 * to the button's `aria-label`, with a hover/focus tooltip carrying the label
 * for sighted pointer users.
 *
 * The play function is the control half of the pair this story forms with
 * {@link IconOnlyWithoutTooltips}: it proves a hover really does open a
 * tooltip here, so the negative assertion over there cannot pass merely
 * because hovering did nothing.
 */
export const IconOnly: Story = {
  args: {
    items: THEME_ITEMS,
    value: "system",
    ariaLabel: "Theme",
    iconOnly: true,
    showTooltips: true,
  },
  argTypes: {
    value: {
      control: "select",
      options: [...THEME_ITEMS.map((item) => item.value), null],
    },
  },
  play: async () => {
    await userEvent.hover(await screen.findByRole("radio", { name: "Light" }));
    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent("Light");
    });
  },
};

/**
 * The same control with `showTooltips={false}`. Exactly one call site passes
 * it, `theme-toggle.tsx`, as `showTooltips={!pointerCoarse}`, so this is the
 * treatment every touch user gets and {@link IconOnly} is the desktop one.
 * Suppressing the tooltip leaves the `aria-label` as the only label, which
 * screen readers still read.
 *
 * This story documents the branch as the prop currently defines it. Whether
 * the prop should exist at all is a separate question: the rationale in its
 * docstring is about tooltips on touch generally, which would make it a
 * property of the Tooltip primitive rather than of this one component.
 *
 * A regression that ignored the prop would render identically to
 * {@link IconOnly}, which is precisely what the play function catches: the
 * segments here are plain buttons, not tooltip triggers, so no tooltip opens
 * and none of Radix's trigger state (`data-state`, `aria-describedby`) is
 * mounted on them at all.
 */
export const IconOnlyWithoutTooltips: Story = {
  args: {
    ...IconOnly.args,
    showTooltips: false,
  },
  argTypes: IconOnly.argTypes,
  play: async () => {
    const segment = await screen.findByRole("radio", { name: "Light" });
    await userEvent.hover(segment);

    // Radix stamps `data-state` on every tooltip trigger it mounts, open or
    // closed, and `aria-describedby` once one opens. A segment carrying
    // neither was never wrapped in a Tooltip at all, so there is nothing that
    // could open on hover or linger after a tap. That is a stronger claim
    // than "no tooltip happened to be visible when we looked".
    expect(segment).not.toHaveAttribute("data-state");
    expect(segment).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByRole("tooltip")).toBeNull();
  },
};

/**
 * A second line under each label. Segment height follows content rather than
 * the fixed single-line height, so the sublabel is never clipped.
 */
export const WithSublabels: Story = {
  args: {
    items: [
      { value: "daily", label: "Daily", sublabel: "Every day" },
      { value: "weekly", label: "Weekly", sublabel: "Every 7 days" },
      { value: "monthly", label: "Monthly", sublabel: "Every 30 days" },
    ],
    value: "weekly",
    ariaLabel: "Frequency",
  },
  argTypes: {
    value: { control: "select", options: ["daily", "weekly", "monthly", null] },
  },
};

/** A disabled segment is unclickable and skipped by arrow-key navigation. */
export const WithDisabledSegment: Story = {
  args: {
    items: [
      { value: "small", label: "Small" },
      { value: "medium", label: "Medium", disabled: true },
      { value: "large", label: "Large" },
    ],
    value: "small",
  },
};

/** No segment starts active; the first enabled one takes the roving tab stop. */
export const Unset: Story = {
  args: { value: null },
};
