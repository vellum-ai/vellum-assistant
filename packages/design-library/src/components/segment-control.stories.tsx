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
  },
  argTypes: {
    items: { control: false },
    onChange: { control: false },
    value: {
      control: "select",
      options: [...SIZE_ITEMS.map((item) => item.value), null],
    },
    iconOnly: { control: "boolean" },
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
 * to the button's `aria-label`, with a tooltip carrying the label for sighted
 * pointer users.
 *
 * The play function pins the pointer-dependence of that tooltip, in the order
 * that makes each half meaningful. A touch tap must leave no tooltip behind:
 * Radix opens on hover and on keyboard focus, but ignores `pointerType:
 * "touch"` on move and refuses to open on a focus that arrived from a pointer
 * press. A hover must then open one. The hover half is what stops the touch
 * half passing vacuously, since a harness that dispatched nothing at all would
 * satisfy the first assertion and fail the second.
 *
 * This is the contract that made a `showTooltips` opt-out unnecessary, so it
 * is worth holding: a hand-rolled tooltip that opened on focus unconditionally
 * would strand a label over the UI after every tap, and would fail here.
 */
export const IconOnly: Story = {
  args: {
    items: THEME_ITEMS,
    value: "system",
    ariaLabel: "Theme",
    iconOnly: true,
  },
  argTypes: {
    value: {
      control: "select",
      options: [...THEME_ITEMS.map((item) => item.value), null],
    },
  },
  play: async () => {
    const segment = await screen.findByRole("radio", { name: "Light" });

    await userEvent.pointer({ keys: "[TouchA]", target: segment });
    expect(screen.queryByRole("tooltip")).toBeNull();

    await userEvent.hover(segment);
    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent("Light");
    });
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
