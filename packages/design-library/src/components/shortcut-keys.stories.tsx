import type { Meta, StoryObj } from "@storybook/react-vite";

import { ShortcutKeys } from "./shortcut-keys";

const meta: Meta<typeof ShortcutKeys> = {
  title: "Components/ShortcutKeys",
  component: ShortcutKeys,
  argTypes: {
    accelerator: { control: "text" },
    platform: { control: "inline-radio", options: ["mac", "windows"] },
    variant: { control: "inline-radio", options: ["caps", "inline"] },
  },
};

export default meta;

type Story = StoryObj<typeof ShortcutKeys>;

export const Default: Story = {
  args: { accelerator: "CmdOrCtrl+Shift+N" },
};

/**
 * The compact form a dense row has space for: a menu row or a palette result,
 * beside the command's name rather than as the subject of the row.
 */
export const Inline: Story = {
  args: { accelerator: "CmdOrCtrl+Shift+N", variant: "inline" },
};

export const SingleModifier: Story = {
  args: { accelerator: "CmdOrCtrl+N" },
};

export const ArrowKey: Story = {
  args: { accelerator: "CmdOrCtrl+Up" },
};

export const PunctuationKey: Story = {
  args: { accelerator: "CmdOrCtrl+\\" },
};

export const AllModifiers: Story = {
  args: { accelerator: "CmdOrCtrl+Control+Alt+Shift+K" },
};

export const Windows: Story = {
  args: { accelerator: "CmdOrCtrl+Shift+N", platform: "windows" },
};

export const Gallery: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {[
        "CmdOrCtrl+Shift+G",
        "CmdOrCtrl+Shift+/",
        "CmdOrCtrl+N",
        "CmdOrCtrl+\\",
        "CmdOrCtrl+Up",
        "CmdOrCtrl+Down",
      ].map((accelerator) => (
        <div
          key={accelerator}
          style={{ display: "flex", alignItems: "center", gap: 12 }}
        >
          <code style={{ width: 180 }}>{accelerator}</code>
          <ShortcutKeys accelerator={accelerator} />
        </div>
      ))}
    </div>
  ),
};
