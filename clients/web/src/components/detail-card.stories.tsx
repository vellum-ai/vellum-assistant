import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button, Toggle } from "@vellumai/design-library";

import { DetailCard } from "./detail-card";

/**
 * The page-level details card: settings pages, contacts, channels. For a card
 * nested inside a sidepanel body or a modal, reach for
 * `Components/InsetDetailCard` instead: this one's 20px title and 16px
 * corners are scaled for a full surface.
 */
const meta: Meta<typeof DetailCard> = {
  title: "Components/DetailCard",
  component: DetailCard,
  argTypes: {
    variant: { control: "inline-radio", options: ["default", "danger"] },
    accessory: { control: false },
    children: { control: false },
  },
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-[560px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof DetailCard>;

function Body({ text }: { text: string }) {
  return (
    <p className="text-body-medium-lighter text-[var(--content-secondary)]">
      {text}
    </p>
  );
}

export const Default: Story = {
  args: {
    title: "Recent runs",
    children: <Body text="The last few times this task ran." />,
  },
};

export const WithSubtitle: Story = {
  args: {
    title: "Memory",
    subtitle: "What your assistant remembers between conversations.",
    children: <Body text="Memory is on." />,
  },
};

/** Header right-hand slot: a control that acts on the whole card. */
export const WithAccessory: Story = {
  args: {
    title: "Share diagnostics",
    subtitle: "Send crash reports and session replay data.",
    accessory: <Toggle checked onChange={() => {}} aria-label="Share diagnostics" />,
    children: null,
  },
};

/** `compactAccessory` keeps the accessory on the title's row at every width. */
export const CompactAccessory: Story = {
  args: {
    title: "Pair a device",
    compactAccessory: true,
    accessory: (
      <Button variant="outlined" size="compact">
        Pair
      </Button>
    ),
    children: <Body text="Scan the code from your phone." />,
  },
};

/** `showBorder={false}` drops the card chrome, keeping only the heading rhythm. */
export const Borderless: Story = {
  args: {
    title: "Advanced",
    showBorder: false,
    children: <Body text="Settings most people never need to touch." />,
  },
};

/** The destructive variant, for irreversible actions. */
export const Danger: Story = {
  args: {
    title: "Delete assistant",
    variant: "danger",
    subtitle: "This cannot be undone.",
    children: (
      <Button variant="dangerOutline" size="compact">
        Delete
      </Button>
    ),
  },
};

