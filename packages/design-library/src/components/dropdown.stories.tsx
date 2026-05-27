import type { Meta, StoryObj } from "@storybook/react-vite";
import { Globe, Lock, Users } from "lucide-react";
import { useState } from "react";

import { Dropdown, type DropdownOption, type DropdownProps } from "./dropdown";
import { Tag } from "./tag";

const fruits: DropdownOption<string>[] = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "cherry", label: "Cherry" },
  { value: "dragonfruit", label: "Dragonfruit" },
  { value: "elderberry", label: "Elderberry" },
];

const meta: Meta<DropdownProps<string>> = {
  title: "Components/Dropdown",
  component: Dropdown,
  parameters: {
    layout: "centered",
  },
  argTypes: {
    placeholder: { control: "text" },
    disabled: { control: "boolean" },
    menuAlign: { control: "select", options: ["start", "center", "end"] },
    menuMaxHeight: { control: "number" },
    menuMinWidth: { control: "number" },
    "aria-label": { control: "text" },
    options: { control: false },
    value: { control: false },
    onChange: { control: false },
  },
};

export default meta;
type Story = StoryObj<DropdownProps<string>>;

export const Default: Story = {
  args: {
    "aria-label": "Fruit",
  },
  render: function DefaultDropdown(args) {
    const [value, setValue] = useState("apple");
    return (
      <div className="w-64">
        <Dropdown
          {...args}
          options={fruits}
          value={value}
          onChange={setValue}
        />
      </div>
    );
  },
};

export const WithPlaceholder: Story = {
  args: {
    placeholder: "Select a fruit…",
    "aria-label": "Fruit",
  },
  render: function PlaceholderDropdown(args) {
    const [value, setValue] = useState("");
    return (
      <div className="w-64">
        <Dropdown
          {...args}
          options={fruits}
          value={value}
          onChange={setValue}
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
  args: {
    "aria-label": "Visibility",
  },
  render: function IconDropdown(args) {
    const [value, setValue] = useState<"public" | "team" | "private">("public");
    return (
      <div className="w-64">
        <Dropdown
          {...(args as DropdownProps<"public" | "team" | "private">)}
          options={visibilityOptions}
          value={value}
          onChange={setValue}
        />
      </div>
    );
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
    "aria-label": "Fruit",
  },
  render: (args) => (
    <div className="w-64">
      <Dropdown
        {...args}
        options={fruits}
        value="banana"
        onChange={() => {}}
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
  args: {
    menuMaxHeight: 200,
    "aria-label": "Option",
  },
  render: function LongListDropdown(args) {
    const [value, setValue] = useState("option-1");
    return (
      <div className="w-64">
        <Dropdown
          {...args}
          options={manyOptions}
          value={value}
          onChange={setValue}
        />
      </div>
    );
  },
};

export const EndAligned: Story = {
  args: {
    menuAlign: "end",
    "aria-label": "Fruit",
  },
  render: function EndAlignedDropdown(args) {
    const [value, setValue] = useState("apple");
    return (
      <div className="flex w-96 justify-end">
        <div className="w-48">
          <Dropdown
            {...args}
            options={fruits}
            value={value}
            onChange={setValue}
          />
        </div>
      </div>
    );
  },
};

const machineSizes: DropdownOption<"small" | "medium" | "large">[] = [
  {
    value: "small",
    label: "Small — 2 vCPU, 3 GiB",
    suffix: <Tag tone="positive">Current</Tag>,
  },
  { value: "medium", label: "Medium — 2.5 vCPU, 5 GiB" },
  { value: "large", label: "Large — 4 vCPU, 8 GiB" },
];

export const WithSuffix: Story = {
  args: {
    "aria-label": "Machine size",
  },
  render: function SuffixDropdown(args) {
    const [value, setValue] = useState<"small" | "medium" | "large">("small");
    return (
      <div className="w-80">
        <Dropdown
          {...(args as DropdownProps<"small" | "medium" | "large">)}
          options={machineSizes}
          value={value}
          onChange={setValue}
        />
      </div>
    );
  },
};
