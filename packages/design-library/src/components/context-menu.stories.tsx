import type { Meta, StoryObj } from "@storybook/react-vite";
import { Clipboard, Pencil, Pin, Trash2 } from "lucide-react";
import { useState } from "react";

import { ContextMenu } from "./context-menu";

const meta: Meta = {
  title: "Components/ContextMenu",
  parameters: {
    layout: "centered",
  },
};

export default meta;
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <ContextMenu.Root>
      <ContextMenu.Trigger>
        <div className="flex h-36 w-72 items-center justify-center rounded-lg border border-dashed border-[var(--border-base)] text-body-medium-lighter text-[var(--content-secondary)]">
          Right-click here
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Content>
        <ContextMenu.Item>Cut</ContextMenu.Item>
        <ContextMenu.Item>Copy</ContextMenu.Item>
        <ContextMenu.Item>Paste</ContextMenu.Item>
        <ContextMenu.Separator />
        <ContextMenu.Item>Select all</ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
  ),
};

export const WithIcons: Story = {
  render: () => (
    <ContextMenu.Root>
      <ContextMenu.Trigger>
        <div className="flex h-36 w-72 items-center justify-center rounded-lg border border-dashed border-[var(--border-base)] text-body-medium-lighter text-[var(--content-secondary)]">
          Right-click for actions
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Content>
        <ContextMenu.Item leftIcon={<Pencil className="h-4 w-4" />}>
          Edit
        </ContextMenu.Item>
        <ContextMenu.Item leftIcon={<Clipboard className="h-4 w-4" />}>
          Copy
        </ContextMenu.Item>
        <ContextMenu.Separator />
        <ContextMenu.Item leftIcon={<Trash2 className="h-4 w-4" />}>
          Delete
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
  ),
};

export const WithCheckboxItems: Story = {
  render: function CheckboxStory() {
    const [bold, setBold] = useState(false);
    const [italic, setItalic] = useState(true);
    return (
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          <div className="flex h-36 w-72 items-center justify-center rounded-lg border border-dashed border-[var(--border-base)] text-body-medium-lighter text-[var(--content-secondary)]">
            Right-click for formatting
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Content>
          <ContextMenu.Label>Formatting</ContextMenu.Label>
          <ContextMenu.CheckboxItem
            checked={bold}
            onCheckedChange={setBold}
            shortcut="CmdOrCtrl+B"
          >
            Bold
          </ContextMenu.CheckboxItem>
          <ContextMenu.CheckboxItem
            checked={italic}
            onCheckedChange={setItalic}
            shortcut="CmdOrCtrl+I"
          >
            Italic
          </ContextMenu.CheckboxItem>
        </ContextMenu.Content>
      </ContextMenu.Root>
    );
  },
};

/** The item slots, driven from Controls so each one can be tried in isolation. */
interface ItemSlotsArgs {
  label: string;
  /** Electron accelerator. Drives both the drawn hint and the announced binding. */
  shortcut: string;
  /** Right-aligned content that is not a shortcut. Stays in the accessible name. */
  trailing: string;
  showIcon: boolean;
  disabled: boolean;
}

/**
 * Mirrors `Menu`'s story of the same name: the two primitives render identical
 * rows, so the slots have to look identical here too.
 */
export const ItemSlots: StoryObj<ItemSlotsArgs> = {
  args: {
    label: "Pin conversation",
    shortcut: "CmdOrCtrl+Shift+P",
    trailing: "",
    showIcon: true,
    disabled: false,
  },
  argTypes: {
    label: { control: "text" },
    shortcut: { control: "text" },
    trailing: { control: "text" },
    showIcon: { control: "boolean" },
    disabled: { control: "boolean" },
  },
  render: (args) => (
    <ContextMenu.Root>
      <ContextMenu.Trigger>
        <div className="flex h-36 w-72 items-center justify-center rounded-lg border border-dashed border-[var(--border-base)] text-body-medium-lighter text-[var(--content-secondary)]">
          Right-click to see the row
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Content>
        <ContextMenu.Item
          leftIcon={args.showIcon ? <Pin className="h-4 w-4" /> : undefined}
          shortcut={args.shortcut || undefined}
          trailing={args.trailing || undefined}
          disabled={args.disabled}
        >
          {args.label}
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
  ),
};

export const WithSubmenu: Story = {
  render: () => (
    <ContextMenu.Root>
      <ContextMenu.Trigger>
        <div className="flex h-36 w-72 items-center justify-center rounded-lg border border-dashed border-[var(--border-base)] text-body-medium-lighter text-[var(--content-secondary)]">
          Right-click for nested menu
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Content>
        <ContextMenu.Item>Back</ContextMenu.Item>
        <ContextMenu.Item>Forward</ContextMenu.Item>
        <ContextMenu.Item>Reload</ContextMenu.Item>
        <ContextMenu.Separator />
        <ContextMenu.Sub>
          <ContextMenu.SubTrigger>More tools</ContextMenu.SubTrigger>
          <ContextMenu.SubContent>
            <ContextMenu.Item>Developer tools</ContextMenu.Item>
            <ContextMenu.Item>Task manager</ContextMenu.Item>
            <ContextMenu.Item>Extensions</ContextMenu.Item>
          </ContextMenu.SubContent>
        </ContextMenu.Sub>
        <ContextMenu.Separator />
        <ContextMenu.Item>View source</ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
  ),
};

export const WithRadioItems: Story = {
  render: function RadioStory() {
    const [alignment, setAlignment] = useState("left");
    return (
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          <div className="flex h-36 w-72 items-center justify-center rounded-lg border border-dashed border-[var(--border-base)] text-body-medium-lighter text-[var(--content-secondary)]">
            Right-click to change alignment
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Content>
          <ContextMenu.Label>Alignment</ContextMenu.Label>
          <ContextMenu.RadioGroup
            value={alignment}
            onValueChange={setAlignment}
          >
            <ContextMenu.RadioItem value="left">Left</ContextMenu.RadioItem>
            <ContextMenu.RadioItem value="center">Center</ContextMenu.RadioItem>
            <ContextMenu.RadioItem value="right">Right</ContextMenu.RadioItem>
          </ContextMenu.RadioGroup>
        </ContextMenu.Content>
      </ContextMenu.Root>
    );
  },
};
