import type { Meta, StoryObj } from "@storybook/react-vite";

import { ShortcutKeys } from "./shortcut-keys";

const meta: Meta<typeof ShortcutKeys> = {
  title: "Components/ShortcutKeys",
  component: ShortcutKeys,
  argTypes: {
    accelerator: { control: "text" },
  },
};

export default meta;

type Story = StoryObj<typeof ShortcutKeys>;

export const Default: Story = {
  args: { accelerator: "CmdOrCtrl+Shift+N" },
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
