import type { Meta, StoryObj } from "@storybook/react-vite";

import { Card, CardBody, CardFooter, CardHeader, CardRoot } from "./card";

const meta: Meta<typeof Card> = {
  title: "Components/Card",
  component: Card,
  argTypes: {
    padding: { control: "select", options: ["sm", "md", "lg"] },
    bordered: { control: "boolean" },
    elevated: { control: "boolean" },
    noPadding: { control: "boolean" },
    clipContents: { control: "boolean" },
  },
};

export default meta;

type Story = StoryObj<typeof Card>;

export const Default: Story = {
  args: { children: "A simple card with default settings." },
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
