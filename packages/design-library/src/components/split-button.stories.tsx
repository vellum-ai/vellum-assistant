import type { Meta, StoryObj } from "@storybook/react-vite";
import { KeyRound, Plus, ShieldCheck } from "lucide-react";

import { ActionMenu } from "./action-menu";
import { SplitButton } from "./split-button";

/**
 * The recommended action stays one click away; everything else that would do
 * the same job hides behind the chevron. Give the menu real items to see the
 * split treatment, or clear them to watch it collapse back to a plain button.
 */
const meta: Meta<typeof SplitButton> = {
  title: "Components/SplitButton",
  component: SplitButton,
  parameters: { layout: "centered" },
  args: {
    children: "Connect",
    menuTitle: "Other ways to connect",
    menuTriggerLabel: "Other ways to connect Notion",
    menuAlign: "end",
    variant: "primary",
    size: "regular",
    disabled: false,
    fullWidth: false,
    menuItems: [
      <ActionMenu.Item
        key="vellum"
        icon={ShieldCheck}
        label="Sign in through Vellum"
      />,
      <ActionMenu.Item
        key="own"
        icon={KeyRound}
        label="Use your own OAuth app"
      />,
    ],
  },
  argTypes: {
    variant: {
      control: "select",
      options: [
        "primary",
        "outlined",
        "ghost",
        "danger",
        "dangerOutline",
        "dangerGhost",
        "link",
      ],
    },
    size: { control: "inline-radio", options: ["regular", "compact"] },
    menuAlign: { control: "inline-radio", options: ["start", "end"] },
    menuItems: { control: false },
    iconOnly: { control: false },
    leftIcon: { control: false },
    ref: { control: false },
    onClick: { control: false },
  },
};

export default meta;
type Story = StoryObj<typeof SplitButton>;

export const Default: Story = {};

/** No alternatives, so no chevron, but the same root the menu version has. */
export const NoMenu: Story = { args: { menuItems: undefined } };

/** The pair stretches; the chevron keeps its square icon width. */
export const FullWidth: Story = {
  args: { fullWidth: true },
  decorators: [
    (Story) => (
      <div className="w-100">
        <Story />
      </div>
    ),
  ],
};

export const Outlined: Story = { args: { variant: "outlined" } };

/** Both halves take the disabled state, so the pair reads as one control. */
export const Disabled: Story = { args: { disabled: true } };

/**
 * The main action is blocked but the alternatives are a way out of what is
 * blocking it, so the chevron opts out of the disabled state.
 */
export const DisabledWithLiveMenu: Story = {
  args: { disabled: true, menuDisabled: false },
};

/**
 * A square main half for a surface with no room for a verb. The label moves to
 * `aria-label`, and the chevron keeps the same square footprint.
 */
export const IconOnly: Story = {
  args: {
    iconOnly: <Plus />,
    children: undefined,
    variant: "outlined",
    "aria-label": "Connect Notion",
  },
};
