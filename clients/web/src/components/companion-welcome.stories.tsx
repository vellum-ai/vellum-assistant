import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SystemPermissionStatus } from "@vellumai/ipc-contract";
import { useState, type ComponentProps, type ReactNode } from "react";

import {
  CompanionWelcome,
  type CompanionWelcomePermission,
  type CompanionWelcomeStep,
} from "@/components/companion-welcome";

/**
 * The companion's first-use welcome, one story per step so each can be
 * reviewed without clicking through the ones before it. `Walkthrough` is the
 * whole run from the start, with answers logged to the Actions panel.
 *
 * The first step's demo video is not recorded yet. Paste a URL into
 * `demoVideoSrc` to see one play after the eyes sink; without one the panel
 * falls back to the stand-in desktop.
 *
 * Permissions start unasked and flip to allowed when their button is pressed,
 * standing in for the host re-reading state after the system prompt.
 */

type Permissions = Partial<
  Record<CompanionWelcomePermission, SystemPermissionStatus>
>;

function StatefulWelcome(
  props: ComponentProps<typeof CompanionWelcome>,
): ReactNode {
  const [permissions, setPermissions] = useState<Permissions>(
    props.permissions ?? {},
  );
  return (
    <CompanionWelcome
      {...props}
      permissions={permissions}
      onRequestPermission={(kind) => {
        props.onRequestPermission?.(kind);
        setPermissions((current) => ({ ...current, [kind]: "granted" }));
      }}
    />
  );
}

const meta: Meta<typeof CompanionWelcome> = {
  title: "Companion/Welcome",
  component: CompanionWelcome,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    assistantName: "Ziggy",
    accentHex: "#5eead4",
    character: { bodyShape: "burst", eyeStyle: "curious", color: "teal" },
    initialStep: "meet",
    demoVideoSrc: "",
    permissions: { microphone: "not-determined", screen: "not-determined" },
  },
  argTypes: {
    initialStep: {
      control: "inline-radio",
      options: [
        "meet",
        "find",
        "talk",
        "setup",
        "try",
        "keys",
      ] satisfies CompanionWelcomeStep[],
    },
    demoVideoSrc: { control: "text" },
    permissions: { control: "object" },
    onComplete: { action: "complete" },
    onDismiss: { action: "dismiss" },
    onRequestPermission: { action: "requestPermission" },
  },
  // Keyed on what a reviewer changes in the controls, so the modal restarts
  // from that state rather than keeping the step and permissions it had.
  render: (args) => (
    <StatefulWelcome
      key={`${args.initialStep}:${args.demoVideoSrc}:${JSON.stringify(args.permissions)}`}
      {...args}
    />
  ),
};

export default meta;
type Story = StoryObj<typeof CompanionWelcome>;

/** The whole run from the first step. */
export const Walkthrough: Story = {};

/** The same run on the dark app theme. The desktop picture stays a desktop. */
export const WalkthroughDark: Story = { globals: { theme: "dark" } };

/** Before the app has a name to greet with. */
export const Unnamed: Story = { args: { assistantName: undefined } };

export const Find: Story = { args: { initialStep: "find" } };

export const Talk: Story = { args: { initialStep: "talk" } };

/** Neither permission asked for yet. */
export const Setup: Story = { args: { initialStep: "setup" } };

/**
 * The microphone allowed and screen recording refused earlier, which can only
 * be changed in System Settings now.
 */
export const SetupScreenDenied: Story = {
  args: {
    initialStep: "setup",
    permissions: { microphone: "granted", screen: "denied" },
  },
};

export const Try: Story = { args: { initialStep: "try" } };

export const Keys: Story = { args: { initialStep: "keys" } };

/** In an orange assistant's colour, which the bars and pill both follow. */
export const OrangeAssistant: Story = {
  args: {
    accentHex: "#E9642F",
    character: { bodyShape: "burst", eyeStyle: "curious", color: "orange" },
  },
};
