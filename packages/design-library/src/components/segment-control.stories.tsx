import { Monitor, Moon, Sun } from "lucide-react";
import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";
import { expect, screen, userEvent, waitFor } from "storybook/test";

import { WithoutHover } from "../utils/hover-capability.story-helper";
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
 * users who can hover. {@link IconOnlyTooltipBehaviour} and
 * {@link IconOnlyWithoutHover} are the interactive siblings that exercise where
 * that tooltip appears and where it does not.
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
 * Holds the absence of a tooltip across the open delay, rather than sampling
 * once: a label that only arrives after the delay is exactly the one a static
 * check would miss.
 */
async function expectNoTooltip() {
  await expect(
    waitFor(() => expect(screen.getByRole("tooltip")).toBeInTheDocument(), {
      timeout: 600,
    }),
  ).rejects.toThrow();
}

/**
 * The interactive sibling of {@link IconOnly}, owning `value` in local state
 * rather than through `useArgs`. Arg writes reach the canvas over the preview
 * channel, which the test runner does not turn, so a tap in an args-backed
 * story would leave the selection unchanged there and identical assertions
 * would mean different things in Storybook and in CI.
 *
 * Where the browser can hover, hovering a segment opens its label. This is the
 * half that stops {@link IconOnlyWithoutHover} passing vacuously, since a
 * harness that dispatched nothing at all would satisfy that story and fail
 * this one.
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

    await userEvent.hover(segment);
    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent("Light");
    });
  },
};

/**
 * The same control on a device that reports it cannot hover, which is where a
 * tooltip has no gesture that both opens and closes it. Nothing mounts: the
 * label lives on the button's `aria-label`, which a screen reader reads either
 * way.
 *
 * Three gestures, because they reach the trigger by different routes. Chromium
 * delivers `focus` inside the pointer sequence, where Radix's pointer-down flag
 * is still set. Safari delivers it in the compatibility mouse burst *after*
 * `pointerup`, by which point a document-level listener has cleared that flag,
 * so focus is a tooltip-opening event there and only the `click` from the same
 * burst takes one away again; a gesture with no `click` (a scroll, a long
 * press) leaves it standing. `userEvent` emits only the Chromium ordering, so
 * the Safari one is dispatched by hand. Hover is dispatched too, since a hybrid
 * can still deliver one.
 */
export const IconOnlyWithoutHover: Story = {
  args: { ...IconOnly.args },
  parameters: { controls: { disable: true } },
  render: function Render(args) {
    const [value, setValue] = useState<DemoValue | null>("system");
    return (
      <WithoutHover>
        <SegmentControl {...args} value={value} onChange={setValue} />
      </WithoutHover>
    );
  },
  play: async () => {
    const segment = await screen.findByRole("radio", { name: "Light" });

    await userEvent.pointer({ keys: "[TouchA]", target: segment });
    await expectNoTooltip();

    segment.blur();
    dispatchSafariTap(segment);
    await expectNoTooltip();

    await userEvent.hover(segment);
    await expectNoTooltip();
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
