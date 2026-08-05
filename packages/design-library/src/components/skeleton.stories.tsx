import type { Meta, StoryObj } from "@storybook/react-vite";

import { Skeleton } from "./skeleton";

const meta: Meta<typeof Skeleton> = {
  title: "Components/Skeleton",
  component: Skeleton,
  args: {
    className: "h-4 w-48",
    as: "div",
  },
  argTypes: {
    as: {
      control: "inline-radio",
      options: ["div", "span"],
    },
    className: { control: "text" },
  },
};

export default meta;

type Story = StoryObj<typeof Skeleton>;

/** Arg-driven: size and shape come from `className`. */
export const Default: Story = {};

/** A prose-shaped block: staggered line widths read as loading text. */
export const Paragraph: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex w-80 flex-col gap-3">
      <Skeleton className="h-4 w-2/5" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  ),
};

/** Common shapes: a list row, a card, and an inline chip-sized placeholder. */
export const Shapes: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex w-80 flex-col gap-4">
      <div className="flex items-center gap-3">
        <Skeleton className="size-8 rounded-full" />
        <Skeleton className="h-4 w-40" />
      </div>
      <Skeleton className="h-16 w-full rounded-md" />
      <p className="text-body-small-default">
        Inline in text flow:{" "}
        <Skeleton as="span" className="inline-block h-4 w-24 align-middle" />
      </p>
    </div>
  ),
};
