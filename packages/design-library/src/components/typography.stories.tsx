import type { Meta, StoryObj } from "@storybook/react-vite";

import type { TypographyVariant } from "./typography";
import { Typography } from "./typography";

const meta: Meta<typeof Typography> = {
  title: "Components/Typography",
  component: Typography,
  argTypes: {
    variant: {
      control: "select",
      options: [
        "title-large",
        "title-medium",
        "title-small",
        "body-large-lighter",
        "body-large-default",
        "body-medium-lighter",
        "body-medium-default",
        "body-small-default",
        "body-small-emphasised",
        "label-medium-default",
        "label-small-default",
        "chat",
      ] satisfies TypographyVariant[],
    },
    as: {
      control: "select",
      options: ["span", "p", "div", "label", "h1", "h2", "h3", "h4", "h5", "h6"],
    },
  },
};

export default meta;

type Story = StoryObj<typeof Typography>;

export const Default: Story = {
  args: {
    variant: "body-medium-default",
    children: "The quick brown fox jumps over the lazy dog.",
  },
};

export const TitleLarge: Story = {
  args: { variant: "title-large", as: "h1", children: "Title Large" },
};

export const TitleMedium: Story = {
  args: { variant: "title-medium", as: "h2", children: "Title Medium" },
};

export const TitleSmall: Story = {
  args: { variant: "title-small", as: "h3", children: "Title Small" },
};

const ALL_VARIANTS: TypographyVariant[] = [
  "title-large",
  "title-medium",
  "title-small",
  "body-large-lighter",
  "body-large-default",
  "body-medium-lighter",
  "body-medium-default",
  "body-small-default",
  "body-small-emphasised",
  "label-medium-default",
  "label-small-default",
  "chat",
];

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {ALL_VARIANTS.map((v) => (
        <Typography key={v} variant={v} as="p">
          {v}
        </Typography>
      ))}
    </div>
  ),
};
