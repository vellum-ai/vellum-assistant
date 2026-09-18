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
      options: ["compact", "regular", "large"],
    },
    shape: {
      control: "inline-radio",
      options: ["default", "pill"],
    },
    loading: { control: "boolean" },
    disabled: { control: "boolean" },
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
      <Button size="large">Large</Button>
      <Button size="regular">Regular</Button>
      <Button size="compact">Compact</Button>
    </div>
  ),
  parameters: { controls: { disable: true } },
};

export const Large: Story = {
  args: { variant: "primary", size: "large", children: "Continue" },
};

export const Pill: Story = {
  args: { variant: "outlined", shape: "pill", children: "Pill" },
};

export const Loading: Story = {
  args: { variant: "primary", loading: true, children: "Saving" },
};

/**
 * Every place the spinner can land: in place of a leading icon, in the leading
 * slot of a button that has none, as the icon-only glyph, and beside the
 * greyed look a caller keeps by passing `disabled` as well.
 */
export const LoadingStates: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
      <Button loading leftIcon={<Download />}>
        Download
      </Button>
      <Button variant="outlined" loading>
        Save
      </Button>
      <Button variant="ghost" loading iconOnly={<Settings />} aria-label="Settings" />
      <Button variant="danger" loading disabled>
        Deleting
      </Button>
      <Button size="large" loading>
        Continue
      </Button>
      <Button size="compact" variant="outlined" loading>
        Retry
      </Button>
    </div>
  ),
  parameters: { controls: { disable: true } },
};

export const Shapes: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
      <Button shape="pill">Primary pill</Button>
      <Button variant="outlined" shape="pill" leftIcon={<Plus />}>
        Outlined pill
      </Button>
      <Button variant="ghost" active shape="pill">
        Active ghost pill
      </Button>
      <Button variant="ghost" shape="pill" iconOnly={<X />} aria-label="Close" />
      <Button size="large" shape="pill">
        Large pill
      </Button>
    </div>
  ),
  parameters: { controls: { disable: true } },
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
      <Button active>Primary active</Button>
      <Button variant="ghost" active>Ghost active</Button>
      <Button variant="outlined" active>Outlined active</Button>
    </div>
  ),
};
