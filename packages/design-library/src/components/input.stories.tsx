import { Mail, Search } from "lucide-react";
import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";

import { Input, Textarea } from "./input";

const meta: Meta<typeof Input> = {
  title: "Components/Input",
  component: Input,
  args: {
    label: "Workspace name",
    placeholder: "Acme Inc.",
    value: "",
    fullWidth: true,
    disabled: false,
  },
  argTypes: {
    // Slots/handlers aren't editable text; hide them from Controls.
    leftIcon: { control: false },
    rightIcon: { control: false },
    ref: { control: false },
  },
  // Controlled: drive `value` from the arg and write it back on change.
  render: function Render(args) {
    const [{ value }, updateArgs] = useArgs();
    return (
      <div style={{ width: 320 }}>
        <Input
          {...args}
          value={value}
          onChange={(e) => updateArgs({ value: e.target.value })}
        />
      </div>
    );
  },
};

export default meta;

type Story = StoryObj<typeof Input>;

/** Arg-driven: type in the field or edit label/placeholder/helper in Controls. */
export const Default: Story = {};

/** Helper text below the field. */
export const WithHelperText: Story = {
  args: {
    label: "Email",
    type: "email",
    placeholder: "you@example.com",
    helperText: "We'll never share your email.",
  },
};

/** Error state — the border turns negative and the message replaces helper text. */
export const WithError: Story = {
  args: {
    label: "Email",
    value: "not-an-email",
    errorText: "Enter a valid email address.",
  },
};

/** Left and right icon slots. Stateful showcase, so Controls are disabled. */
export const WithIcons: Story = {
  parameters: { controls: { disable: true } },
  render: () => {
    function IconsDemo() {
      const [search, setSearch] = useState("");
      const [email, setEmail] = useState("");
      return (
        <div
          style={{
            width: 320,
            display: "flex",
            flexDirection: "column",
            gap: "1rem",
          }}
        >
          <Input
            aria-label="Search"
            placeholder="Search…"
            leftIcon={<Search className="h-4 w-4" />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            fullWidth
          />
          <Input
            aria-label="Email"
            placeholder="you@example.com"
            rightIcon={<Mail className="h-4 w-4" />}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            fullWidth
          />
        </div>
      );
    }
    return <IconsDemo />;
  },
};

/** Disabled field. */
export const Disabled: Story = {
  args: { value: "Acme Inc.", disabled: true },
};

/** The multi-line `Textarea` shares the field styling and states. */
export const TextareaField: Story = {
  parameters: { controls: { disable: true } },
  render: () => {
    function TextareaDemo() {
      const [value, setValue] = useState("");
      return (
        <div style={{ width: 360 }}>
          <Textarea
            label="Notes"
            placeholder="Add any context the assistant should know…"
            helperText="Markdown is supported."
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={4}
            fullWidth
          />
        </div>
      );
    }
    return <TextareaDemo />;
  },
};
