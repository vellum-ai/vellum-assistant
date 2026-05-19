import type { Meta, StoryObj } from "@storybook/react-vite";
import { Search, Mail, Eye } from "lucide-react";

import { Input, Textarea } from "./input.js";

const meta: Meta = {
  title: "Components/Input",
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-4">
      <Input placeholder="Enter text…" />
      <Input label="Email" placeholder="user@example.com" />
      <Input label="With helper" helperText="We'll never share your email." placeholder="user@example.com" />
      <Input label="With error" errorText="This field is required" placeholder="Required field" />
    </div>
  ),
};

export const WithIcons: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-4">
      <Input label="Search" placeholder="Search…" leftIcon={<Search className="h-4 w-4" />} />
      <Input label="Email" placeholder="user@example.com" leftIcon={<Mail className="h-4 w-4" />} rightIcon={<Eye className="h-4 w-4" />} />
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-4">
      <Input label="Disabled" placeholder="Cannot edit" disabled />
      <Input label="Disabled with value" value="Read-only content" disabled />
    </div>
  ),
};

export const TextareaStory: Story = {
  name: "Textarea",
  render: () => (
    <div className="flex w-80 flex-col gap-4">
      <Textarea label="Description" placeholder="Enter a description…" />
      <Textarea label="With error" errorText="Too short" placeholder="Write more…" />
      <Textarea label="Disabled" placeholder="Cannot edit" disabled />
    </div>
  ),
};
