import type { Meta, StoryObj } from "@storybook/react-vite";
import { Globe, Lock, Users } from "lucide-react";
import { useState } from "react";

import { Dropdown, type DropdownOption } from "./dropdown.js";

const meta: Meta = {
  title: "Components/Dropdown",
  parameters: {
    layout: "centered",
  },
};

export default meta;
type Story = StoryObj;

const fruits: DropdownOption<string>[] = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "cherry", label: "Cherry" },
  { value: "dragonfruit", label: "Dragonfruit" },
  { value: "elderberry", label: "Elderberry" },
];

export const Default: Story = {
  render: function DefaultDropdown() {
    const [value, setValue] = useState("apple");
    return (
      <div className="w-64">
        <Dropdown
          options={fruits}
          value={value}
          onChange={setValue}
          aria-label="Fruit"
        />
      </div>
    );
  },
};

export const WithPlaceholder: Story = {
  render: function PlaceholderDropdown() {
    const [value, setValue] = useState("");
    return (
      <div className="w-64">
        <Dropdown
          options={fruits}
          value={value}
          onChange={setValue}
          placeholder="Select a fruit…"
          aria-label="Fruit"
        />
      </div>
    );
  },
};

const visibilityOptions: DropdownOption<"public" | "team" | "private">[] = [
  { value: "public", label: "Public", icon: <Globe className="h-4 w-4" /> },
  { value: "team", label: "Team only", icon: <Users className="h-4 w-4" /> },
  {
    value: "private",
    label: "Private",
    icon: <Lock className="h-4 w-4" />,
  },
];

export const WithIcons: Story = {
  render: function IconDropdown() {
    const [value, setValue] = useState<"public" | "team" | "private">("public");
    return (
      <div className="w-64">
        <Dropdown
          options={visibilityOptions}
          value={value}
          onChange={setValue}
          aria-label="Visibility"
        />
      </div>
    );
  },
};

export const Disabled: Story = {
  render: () => (
    <div className="w-64">
      <Dropdown
        options={fruits}
        value="banana"
        onChange={() => {}}
        disabled
        aria-label="Fruit"
      />
    </div>
  ),
};

const manyOptions: DropdownOption<string>[] = Array.from(
  { length: 20 },
  (_, i) => ({
    value: `option-${i + 1}`,
    label: `Option ${i + 1}`,
  }),
);

export const LongList: Story = {
  render: function LongListDropdown() {
    const [value, setValue] = useState("option-1");
    return (
      <div className="w-64">
        <Dropdown
          options={manyOptions}
          value={value}
          onChange={setValue}
          menuMaxHeight={200}
          aria-label="Option"
        />
      </div>
    );
  },
};

export const EndAligned: Story = {
  render: function EndAlignedDropdown() {
    const [value, setValue] = useState("apple");
    return (
      <div className="flex w-96 justify-end">
        <div className="w-48">
          <Dropdown
            options={fruits}
            value={value}
            onChange={setValue}
            menuAlign="end"
            aria-label="Fruit"
          />
        </div>
      </div>
    );
  },
};
