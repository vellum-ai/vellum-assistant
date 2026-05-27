import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Clipboard,
  LogOut,
  Pencil,
  Settings,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useState } from "react";

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
        <Menu.Item leftIcon={<Clipboard className="h-4 w-4" />}>
          Copy
        </Menu.Item>
        <Menu.Separator />
        <Menu.Item leftIcon={<UserPlus className="h-4 w-4" />}>
          Invite
        </Menu.Item>
        <Menu.Item leftIcon={<Settings className="h-4 w-4" />}>
          Settings
        </Menu.Item>
        <Menu.Separator />
        <Menu.Item leftIcon={<Trash2 className="h-4 w-4" />}>
          Delete
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  ),
};

export const WithShortcuts: Story = {
  render: () => (
    <Menu.Root>
      <Menu.Trigger>
        <Button>File</Button>
      </Menu.Trigger>
      <Menu.Content>
        <Menu.Item shortcut="⌘N">New</Menu.Item>
        <Menu.Item shortcut="⌘O">Open</Menu.Item>
        <Menu.Separator />
        <Menu.Item shortcut="⌘S">Save</Menu.Item>
        <Menu.Item shortcut="⇧⌘S">Save as…</Menu.Item>
        <Menu.Separator />
        <Menu.Item shortcut="⌘Q">Quit</Menu.Item>
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
