import { Monitor, Moon, Sun } from "lucide-react";
import { useState } from "react";
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

/**
 * A tap as Safari sequences it: the compatibility mouse burst, and so `focus`,
 * arrives after `pointerup` rather than between `pointerdown` and it. Written
 * out by hand because `userEvent` emits the Chromium ordering, in which focus
 * lands while the pointer is still down.
 */
function dispatchSafariTap(target: HTMLElement) {
  const touch = {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 1,
    isPrimary: true,
    pointerType: "touch",
  } as const;
  target.dispatchEvent(new PointerEvent("pointerdown", touch));
  target.dispatchEvent(new PointerEvent("pointerup", touch));
  // Radix clears its pointer-down flag from a document-level `pointerup`.
  document.dispatchEvent(new PointerEvent("pointerup", touch));
  target.focus();
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

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
 * pointer users. {@link IconOnlyTooltipBehaviour} is the interactive sibling
 * that exercises when that tooltip appears.
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
};

/**
 * The interactive sibling of {@link IconOnly}, owning `value` in local state
 * rather than through `useArgs`. Arg writes reach the canvas over the preview
 * channel, which the test runner does not turn, so a tap in an args-backed
 * story would leave the selection unchanged there and identical assertions
 * would mean different things in Storybook and in CI.
 *
 * It pins the pointer-dependence of the tooltip. A tap leaves none behind, and
 * a hover opens one. Both halves are needed: the hover is what stops the tap
 * assertions passing vacuously, since a harness that dispatched nothing at all
 * would satisfy them and fail the hover.
 *
 * Two tap orderings are checked, because browsers disagree about when focus
 * lands. Chromium delivers it inside the pointer sequence, where Radix's
 * pointer-down flag is still set and suppresses the focus-open, so nothing
 * opens at all. Safari delivers focus in the compatibility mouse burst *after*
 * `pointerup`, by which point that flag is clear: focus does open the tooltip,
 * and the `click` from the same burst closes it a render later. `userEvent`
 * emits only the Chromium sequence, so the Safari one is dispatched by hand.
 *
 * The gestures that would strand a label are the ones with no `click` to close
 * it, and they are unreachable for the same reason: a scroll cancels the touch
 * and a long press takes the callout path, and neither delivers `focus`
 * either, so neither opens anything to begin with.
 */
export const IconOnlyTooltipBehaviour: Story = {
  args: { ...IconOnly.args },
  // The story owns `value`, so the Controls entry for it would be dead.
  parameters: { controls: { disable: true } },
  render: function Render(args) {
    const [value, setValue] = useState<DemoValue | null>("system");
    return <SegmentControl {...args} value={value} onChange={setValue} />;
  },
  play: async () => {
    const segment = await screen.findByRole("radio", { name: "Light" });

    /**
     * No tooltip may survive a tap. A transient one is tolerated, because the
     * Safari ordering opens on focus and closes on the `click` from the same
     * burst, and those are separate renders. What must not happen is a tooltip
     * that is still there once the dust settles, or one that arrives later:
     * hence settling first and then holding the absence across the open delay,
     * rather than sampling once.
     */
    const expectNoTooltipSurvivesTap = async () => {
      await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
      await expect(
        waitFor(() => expect(screen.getByRole("tooltip")).toBeInTheDocument(), {
          timeout: 600,
        }),
      ).rejects.toThrow();
    };

    await userEvent.pointer({ keys: "[TouchA]", target: segment });
    await expectNoTooltipSurvivesTap();

    segment.blur();
    dispatchSafariTap(segment);
    await expectNoTooltipSurvivesTap();

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
