import { Download, Plus, Settings, X } from "lucide-react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button";

const meta: Meta<typeof Button> = {
  title: "Components/Button",
  component: Button,
  argTypes: {
    variant: {
      control: "select",
      options: ["primary", "outlined", "ghost", "link", "danger", "dangerOutline", "dangerGhost"],
    },
    size: {
      control: "select",
      options: ["regular", "compact"],
    },
    disabled: { control: "boolean" },
    loading: { control: "boolean" },
    fullWidth: { control: "boolean" },
    active: { control: "boolean" },
  },
};

export default meta;

type Story = StoryObj<typeof Button>;

export const Primary: Story = {
  args: { variant: "primary", children: "Primary" },
};

export const Outlined: Story = {
  args: { variant: "outlined", children: "Outlined" },
};

export const Ghost: Story = {
  args: { variant: "ghost", children: "Ghost" },
};

export const Danger: Story = {
  args: { variant: "danger", children: "Danger" },
};

export const DangerOutline: Story = {
  args: { variant: "dangerOutline", children: "Danger outline" },
};

export const DangerGhost: Story = {
  args: { variant: "dangerGhost", children: "Danger ghost" },
};

export const Link: Story = {
  render: () => (
    <p style={{ fontSize: 14 }}>
      Already have a Slack app?{" "}
      <Button variant="link">Skip to next step</Button>
    </p>
  ),
};

export const Compact: Story = {
  args: { variant: "primary", size: "compact", children: "Compact" },
};

export const Disabled: Story = {
  args: { variant: "primary", disabled: true, children: "Disabled" },
};

export const Loading: Story = {
  args: { variant: "primary", loading: true, children: "Connecting" },
};

export const WithIcons: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
      <Button leftIcon={<Download />}>Download</Button>
      <Button rightIcon={<Plus />}>Add item</Button>
      <Button variant="outlined" leftIcon={<Settings />} rightIcon={<Plus />}>
        Configure
      </Button>
    </div>
  ),
};

export const IconOnly: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
      <Button iconOnly={<Plus />} aria-label="Add" />
      <Button variant="outlined" iconOnly={<Settings />} aria-label="Settings" />
      <Button variant="ghost" iconOnly={<X />} aria-label="Close" />
      <Button size="compact" iconOnly={<X />} aria-label="Dismiss" />
    </div>
  ),
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
      <Button variant="primary">Primary</Button>
      <Button variant="outlined">Outlined</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="danger">Danger</Button>
      <Button variant="dangerOutline">Danger outline</Button>
      <Button variant="dangerGhost">Danger ghost</Button>
      <Button variant="link">Link</Button>
    </div>
  ),
};

export const AllSizes: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
      <Button size="regular">Regular</Button>
      <Button size="compact">Compact</Button>
    </div>
  ),
};

export const FullWidth: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <Button fullWidth>Full width primary</Button>
      <Button variant="outlined" fullWidth leftIcon={<Download />}>
        Full width with icon
      </Button>
    </div>
  ),
};

export const Active: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
      <Button variant="ghost" active>Ghost active</Button>
      <Button variant="outlined" active>Outlined active</Button>
    </div>
  ),
};
