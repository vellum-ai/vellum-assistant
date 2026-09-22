import type { Meta, StoryObj } from "@storybook/react-vite";

import { Card, CardBody, CardFooter, CardHeader, CardRoot } from "./card";

const meta: Meta<typeof Card> = {
  title: "Components/Card",
  component: Card,
  argTypes: {
    padding: { control: "select", options: ["sm", "md", "lg"] },
    surface: { control: "inline-radio", options: ["lift", "overlay"] },
    bordered: { control: "boolean" },
    elevated: { control: "boolean" },
    noPadding: { control: "boolean" },
    clipContents: { control: "boolean" },
    interactive: { control: "boolean" },
    selected: { control: "boolean" },
  },
};

export default meta;

type Story = StoryObj<typeof Card>;

export const Default: Story = {
  args: { children: "A simple card with default settings." },
};

/**
 * A card on a `--surface-lift` background, such as a side drawer's body. With
 * the default `lift` fill it would take the background's own color; `overlay`
 * gives it a fill of its own.
 */
export const OnLiftSurface: Story = {
  args: {
    surface: "overlay",
    children: "Card on a lift surface, with the overlay fill.",
  },
  decorators: [
    (Story) => (
      <div className="bg-[var(--surface-lift)] p-6">
        <Story />
      </div>
    ),
  ],
};

export const Bordered: Story = {
  args: {
    bordered: true,
    children: "Card with a visible border.",
  },
};

export const Elevated: Story = {
  args: {
    bordered: true,
    elevated: true,
    children: "Elevated card with shadow.",
  },
};

export const SmallPadding: Story = {
  args: {
    padding: "sm",
    bordered: true,
    children: "Compact card with small padding.",
  },
};

export const LargePadding: Story = {
  args: {
    padding: "lg",
    bordered: true,
    children: "Spacious card with large padding.",
  },
};

export const WithSections: Story = {
  render: () => (
    <CardRoot bordered>
      <CardHeader>Card Title</CardHeader>
      <CardBody>
        <p>Card body content goes here. This demonstrates the sectioned layout.</p>
      </CardBody>
      <CardFooter>
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <button type="button">Cancel</button>
          <button type="button">Save</button>
        </div>
      </CardFooter>
    </CardRoot>
  ),
};

export const NoPadding: Story = {
  args: {
    noPadding: true,
    bordered: true,
    children: "Card with no padding — useful for full-bleed content.",
  },
};

/**
 * `interactive` makes the whole card a click target: pointer cursor, hover and
 * pressed fills, and the keyboard-focus ring. It adds no role or tab stop, so
 * slot a `<button>` in with `asChild` to get the semantics.
 */
export const Interactive: Story = {
  args: { interactive: true, asChild: true, noPadding: true },
  argTypes: { asChild: { control: false }, noPadding: { control: false } },
  render: (args) => (
    <Card {...args}>
      <button type="button" className="p-4">
        Open the weekly report
      </button>
    </Card>
  ),
};

/** The same chrome around a link: `asChild` hands the card's look to the anchor. */
export const InteractiveAsLink: Story = {
  args: { interactive: true, asChild: true, noPadding: true },
  argTypes: { asChild: { control: false }, noPadding: { control: false } },
  render: (args) => (
    <Card {...args}>
      <a href="#report" className="p-4">
        Go to the weekly report
      </a>
    </Card>
  ),
};

/**
 * `selected` draws the chosen card of a set. Visual only: the caller owns the
 * ARIA state. For a tile with radio or checkbox semantics use `OptionCard`.
 */
export const Selected: Story = {
  args: {
    interactive: true,
    selected: true,
    asChild: true,
    noPadding: true,
  },
  argTypes: { asChild: { control: false }, noPadding: { control: false } },
  render: (args) => (
    <Card {...args}>
      <button type="button" aria-pressed={args.selected} className="p-4">
        Weekly report
      </button>
    </Card>
  ),
};
