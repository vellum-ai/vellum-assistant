import type { Meta, StoryObj } from "@storybook/react-vite";

import { TextLink } from "./text-link";

const meta: Meta<typeof TextLink> = {
  title: "Components/TextLink",
  component: TextLink,
  args: { href: "#", children: "Learn more", tone: "default" },
  argTypes: {
    tone: { control: "inline-radio", options: ["default", "quiet"] },
    asChild: { control: false },
    ref: { control: false },
  },
};

export default meta;

type Story = StoryObj<typeof TextLink>;

export const Default: Story = {};

export const Quiet: Story = {
  args: { tone: "quiet" },
  render: (args) => (
    <p
      style={{ fontSize: 12, color: "var(--content-tertiary)", maxWidth: 420 }}
    >
      By continuing you agree to the <TextLink {...args}>Terms of Use</TextLink>{" "}
      and the <TextLink {...args}>Privacy Policy</TextLink>.
    </p>
  ),
};

/** The default tone inside body copy: it takes the paragraph's type scale. */
export const InASentence: Story = {
  render: (args) => (
    <p
      style={{ fontSize: 14, color: "var(--content-default)", maxWidth: 420 }}
    >
      Usage is billed per credit. <TextLink {...args}>See pricing</TextLink> for
      how credits map to model calls.
    </p>
  ),
};

/**
 * `asChild` hands navigation to the caller's element. A plain anchor stands in
 * here for a router `Link` or an app-level external-anchor wrapper.
 */
export const AsChild: Story = {
  render: (args) => (
    <TextLink tone={args.tone} asChild>
      <a href="#routed">Open privacy settings</a>
    </TextLink>
  ),
};

export const Tones: Story = {
  render: () => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        fontSize: 14,
        color: "var(--content-secondary)",
      }}
    >
      <span>
        default: <TextLink href="#">Read the docs</TextLink>
      </span>
      <span>
        quiet: <TextLink tone="quiet" href="#">Read the docs</TextLink>
      </span>
    </div>
  ),
  parameters: { controls: { disable: true } },
};
