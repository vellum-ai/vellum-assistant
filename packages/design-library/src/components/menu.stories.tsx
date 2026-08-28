import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Check,
  Clipboard,
  LogOut,
  Pencil,
  Pin,
  Settings,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";

import { Button } from "./button";
import { Menu } from "./menu";

const meta: Meta = {
  title: "Components/Menu",
  parameters: {
    layout: "centered",
  },
};

export default meta;
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <Menu.Root>
      <Menu.Trigger>
        <Button>Actions</Button>
      </Menu.Trigger>
      <Menu.Content>
        <Menu.Item>New file</Menu.Item>
        <Menu.Item>Open</Menu.Item>
        <Menu.Separator />
        <Menu.Item>Save</Menu.Item>
        <Menu.Item>Save as…</Menu.Item>
      </Menu.Content>
    </Menu.Root>
  ),
};

export const WithIcons: Story = {
  render: () => (
    <Menu.Root>
      <Menu.Trigger>
        <Button variant="outlined">More</Button>
      </Menu.Trigger>
      <Menu.Content>
        <Menu.Item leftIcon={<Pencil className="h-4 w-4" />}>Edit</Menu.Item>
        <Menu.Item leftIcon={<Clipboard className="h-4 w-4" />}>Copy</Menu.Item>
        <Menu.Separator />
        <Menu.Item leftIcon={<UserPlus className="h-4 w-4" />}>
          Invite
        </Menu.Item>
        <Menu.Item leftIcon={<Settings className="h-4 w-4" />}>
          Settings
        </Menu.Item>
        <Menu.Separator />
        <Menu.Item leftIcon={<Trash2 className="h-4 w-4" />}>Delete</Menu.Item>
      </Menu.Content>
    </Menu.Root>
  ),
};

/**
 * Items take the accelerator, not the glyphs. Each row draws the platform's
 * key symbols and announces the same binding through `aria-keyshortcuts`, so
 * the two cannot drift apart.
 */
export const WithShortcuts: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <Menu.Root>
      <Menu.Trigger>
        <Button>File</Button>
      </Menu.Trigger>
      <Menu.Content>
        <Menu.Item shortcut="CmdOrCtrl+N">New</Menu.Item>
        <Menu.Item shortcut="CmdOrCtrl+O">Open</Menu.Item>
        <Menu.Separator />
        <Menu.Item shortcut="CmdOrCtrl+S">Save</Menu.Item>
        <Menu.Item shortcut="CmdOrCtrl+Shift+S">Save as…</Menu.Item>
        <Menu.Separator />
        <Menu.Item shortcut="CmdOrCtrl+Q">Quit</Menu.Item>
      </Menu.Content>
    </Menu.Root>
  ),
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
 * `shortcut` and `trailing` are separate slots because they mean different
 * things to a screen reader: a key hint is drawn but hidden, repeating what
 * `aria-keyshortcuts` announces, while trailing content (a status glyph, a
 * secondary hint) is part of what the row says.
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
  // The row draws the hint and hides it, so the binding reaches assistive tech
  // only through `aria-keyshortcuts`. Asserted on the composed tree, since the
  // item is what has to carry the attribute.
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole("button"));
    const item = await within(document.body).findByRole("menuitem");
    expect(item).toHaveAttribute("aria-keyshortcuts");
    expect(
      item.querySelector('[data-slot="menu-item-shortcut"]'),
    ).toHaveAttribute("aria-hidden", "true");
    expect(item).toHaveAccessibleName(args.label);
  },
  render: (args) => (
    <Menu.Root>
      <Menu.Trigger>
        <Button variant="outlined">Conversation</Button>
      </Menu.Trigger>
      <Menu.Content>
        <Menu.Item
          leftIcon={args.showIcon ? <Pin className="h-4 w-4" /> : undefined}
          shortcut={args.shortcut || undefined}
          trailing={args.trailing || undefined}
          disabled={args.disabled}
        >
          {args.label}
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  ),
};

/**
 * `trailing` carrying a status glyph and a secondary hint, next to a row that
 * has neither, so the shared right column is visible.
 */
export const WithTrailingContent: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <Menu.Root>
      <Menu.Trigger>
        <Button variant="outlined">Model</Button>
      </Menu.Trigger>
      <Menu.Content>
        <Menu.Item trailing={<Check className="h-3.5 w-3.5" />}>
          Balanced
        </Menu.Item>
        <Menu.Item>Fast</Menu.Item>
        <Menu.Item trailing="Preview">Reasoning</Menu.Item>
      </Menu.Content>
    </Menu.Root>
  ),
};

export const WithCheckboxItems: Story = {
  render: function CheckboxStory() {
    const [showGrid, setShowGrid] = useState(true);
    const [showRulers, setShowRulers] = useState(false);
    const [showGuides, setShowGuides] = useState(true);
    return (
      <Menu.Root>
        <Menu.Trigger>
          <Button variant="outlined">View</Button>
        </Menu.Trigger>
        <Menu.Content>
          <Menu.Label>Display</Menu.Label>
          <Menu.CheckboxItem checked={showGrid} onCheckedChange={setShowGrid}>
            Show grid
          </Menu.CheckboxItem>
          <Menu.CheckboxItem
            checked={showRulers}
            onCheckedChange={setShowRulers}
          >
            Show rulers
          </Menu.CheckboxItem>
          <Menu.CheckboxItem
            checked={showGuides}
            onCheckedChange={setShowGuides}
          >
            Show guides
          </Menu.CheckboxItem>
        </Menu.Content>
      </Menu.Root>
    );
  },
};

export const WithRadioItems: Story = {
  render: function RadioStory() {
    const [sort, setSort] = useState("name");
    return (
      <Menu.Root>
        <Menu.Trigger>
          <Button variant="outlined">Sort by</Button>
        </Menu.Trigger>
        <Menu.Content>
          <Menu.Label>Sort order</Menu.Label>
          <Menu.RadioGroup value={sort} onValueChange={setSort}>
            <Menu.RadioItem value="name">Name</Menu.RadioItem>
            <Menu.RadioItem value="date">Date modified</Menu.RadioItem>
            <Menu.RadioItem value="size">Size</Menu.RadioItem>
            <Menu.RadioItem value="type">Type</Menu.RadioItem>
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Root>
    );
  },
};

export const WithSubmenu: Story = {
  render: () => (
    <Menu.Root>
      <Menu.Trigger>
        <Button>Options</Button>
      </Menu.Trigger>
      <Menu.Content>
        <Menu.Item>Cut</Menu.Item>
        <Menu.Item>Copy</Menu.Item>
        <Menu.Item>Paste</Menu.Item>
        <Menu.Separator />
        <Menu.Sub>
          <Menu.SubTrigger>Share</Menu.SubTrigger>
          <Menu.SubContent>
            <Menu.Item>Email</Menu.Item>
            <Menu.Item>Slack</Menu.Item>
            <Menu.Item>Copy link</Menu.Item>
          </Menu.SubContent>
        </Menu.Sub>
        <Menu.Sub>
          <Menu.SubTrigger leftIcon={<LogOut className="h-4 w-4" />}>
            Export
          </Menu.SubTrigger>
          <Menu.SubContent>
            <Menu.Item>PDF</Menu.Item>
            <Menu.Item>CSV</Menu.Item>
            <Menu.Item>JSON</Menu.Item>
          </Menu.SubContent>
        </Menu.Sub>
      </Menu.Content>
    </Menu.Root>
  ),
};

export const DisabledItems: Story = {
  render: () => (
    <Menu.Root>
      <Menu.Trigger>
        <Button>Edit</Button>
      </Menu.Trigger>
      <Menu.Content>
        <Menu.Item>Undo</Menu.Item>
        <Menu.Item disabled>Redo</Menu.Item>
        <Menu.Separator />
        <Menu.Item>Cut</Menu.Item>
        <Menu.Item>Copy</Menu.Item>
        <Menu.Item disabled>Paste</Menu.Item>
      </Menu.Content>
    </Menu.Root>
  ),
};
