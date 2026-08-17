import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";

import { Toggle } from "./toggle";

const meta: Meta<typeof Toggle> = {
  title: "Components/Toggle",
  component: Toggle,
  argTypes: {
    size: { control: "inline-radio", options: ["md", "sm"] },
    onChange: { control: false },
  },
  args: {
    checked: false,
    label: "Airplane mode",
    disabled: false,
    // Mirrors the component's own default, so Controls opens on the real
    // starting value instead of a blank size.
    size: "md",
  },
  // Controlled: drive `checked` from the arg and write it back on change so
  // the Controls panel and canvas stay in sync.
  render: function Render(args) {
    const [{ checked }, updateArgs] = useArgs();
    return (
      <Toggle
        {...args}
        checked={checked}
        onChange={(next) => updateArgs({ checked: next })}
      />
    );
  },
};

export default meta;

type Story = StoryObj<typeof Toggle>;

/** Arg-driven: flip `checked` and `disabled`, edit the label, in Controls. */
export const Default: Story = {
  args: { checked: true },
};

/** A label plus secondary helper copy. */
export const WithHelperText: Story = {
  args: {
    label: "Do not disturb",
    helperText: "Silence notifications until you turn this off.",
  },
};

/** Both positions and their disabled forms (static — no shared control). */
export const AllStates: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <Toggle checked={false} label="Off" onChange={() => {}} />
      <Toggle checked label="On" onChange={() => {}} />
      <Toggle
        checked={false}
        label="Disabled off"
        disabled
        onChange={() => {}}
      />
      <Toggle checked label="Disabled on" disabled onChange={() => {}} />
    </div>
  ),
};

/** No label — a bare switch driven only by `aria-label`. */
export const NoLabel: Story = {
  args: { label: undefined, "aria-label": "Standalone toggle" },
};

/** The 16px-track size, for dense rows (e.g. inside a sidepanel details card). */
export const Small: Story = {
  args: { size: "sm", checked: true, label: "Airplane mode" },
};

/**
 * Both sizes together. `md` (24px track) is the page-level default; `sm`
 * (16px) is for dense contexts. Each is shown off and on, since the knob
 * offset is derived per size.
 */
export const Sizes: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <Toggle
        checked={false}
        label="md - off (24px track)"
        onChange={() => {}}
      />
      <Toggle checked label="md - on (24px track)" onChange={() => {}} />
      <Toggle
        size="sm"
        checked={false}
        label="sm - off (16px track)"
        onChange={() => {}}
      />
      <Toggle
        size="sm"
        checked
        label="sm - on (16px track)"
        onChange={() => {}}
      />
    </div>
  ),
};
