import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, screen, userEvent, waitFor } from "storybook/test";

import { SearchableSelect, type SearchableSelectOption } from "./searchable-select";

const MODELS: SearchableSelectOption[] = [
  { value: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { value: "claude-fable-5", label: "Claude Fable 5" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { value: "gpt-5-6", label: "GPT-5.6" },
  { value: "gpt-5-6-mini", label: "GPT-5.6 Mini" },
  { value: "gemini-3-pro", label: "Gemini 3 Pro" },
  { value: "gemini-3-flash", label: "Gemini 3 Flash" },
  { value: "kimi-k3", label: "Kimi K3" },
  { value: "glm-5-2", label: "GLM 5.2" },
  { value: "minimax-m3", label: "MiniMax M3" },
  { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { value: "__custom__", label: "Enter a custom model ID…", sticky: true },
];

/**
 * A `Select` whose list is filtered by typing. Use it once the option list
 * outgrows what a person can scan in a dropdown; below about a dozen rows,
 * plain `Select` is the simpler control.
 *
 * The list is portaled, so it is not clipped by a scrolling modal body or
 * sidepanel, and the sticky row stays reachable however far the list scrolls.
 */
const meta: Meta<typeof SearchableSelect> = {
  title: "Components/SearchableSelect",
  component: SearchableSelect,
  args: {
    options: MODELS,
    label: "Model",
    placeholder: "Select a model",
    emptyText: "No matching models",
  },
  argTypes: {
    options: { control: false },
    value: { control: false },
    onChange: { control: false },
  },
  decorators: [
    (Story) => (
      <div className="w-[360px] p-6">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof SearchableSelect>;

function Controlled(args: React.ComponentProps<typeof SearchableSelect>) {
  const [value, setValue] = useState(args.value);
  return <SearchableSelect {...args} value={value} onChange={setValue} />;
}

export const Empty: Story = {
  args: { value: "" },
  render: (args) => <Controlled {...args} />,
};

export const WithSelection: Story = {
  args: { value: "claude-opus-4-8" },
  render: (args) => <Controlled {...args} />,
};

export const Disabled: Story = {
  args: { value: "claude-opus-4-8", disabled: true },
  render: (args) => <Controlled {...args} />,
};

export const WithError: Story = {
  args: { value: "", errorText: "Select a model" },
  render: (args) => <Controlled {...args} />,
};

/**
 * Typing narrows the list to the matches, and the sticky escape hatch stays
 * on screen even when nothing matches.
 */
export const TypeToFilter: Story = {
  args: { value: "" },
  render: (args) => <Controlled {...args} />,
  play: async ({ canvasElement }) => {
    const field = canvasElement.querySelector<HTMLInputElement>(
      'input[role="combobox"]',
    );
    if (!field) {
      throw new Error("expected the combobox field");
    }
    await userEvent.click(field);
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());

    await userEvent.type(field, "gemini");
    await waitFor(() => {
      const labels = screen
        .getAllByRole("option")
        .map((option) => option.textContent);
      expect(labels).toEqual([
        "Gemini 3 Pro",
        "Gemini 3 Flash",
        "Enter a custom model ID…",
      ]);
    });

    await userEvent.click(screen.getByText("Gemini 3 Flash"));
    await waitFor(() => expect(field.value).toBe("Gemini 3 Flash"));
  },
};

/**
 * A query that matches nothing still offers the sticky row, alongside the
 * empty message.
 */
export const NoMatches: Story = {
  args: { value: "" },
  render: (args) => <Controlled {...args} />,
  play: async ({ canvasElement }) => {
    const field = canvasElement.querySelector<HTMLInputElement>(
      'input[role="combobox"]',
    );
    if (!field) {
      throw new Error("expected the combobox field");
    }
    await userEvent.click(field);
    await userEvent.type(field, "zzzz");
    await waitFor(() => {
      expect(screen.getByText("No matching models")).toBeTruthy();
      expect(
        screen.getAllByRole("option").map((option) => option.textContent),
      ).toEqual(["Enter a custom model ID…"]);
    });
  },
};
