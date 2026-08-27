import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { useArgs } from "storybook/preview-api";
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
  // Shared by every presentational story: `SearchableSelect` is controlled,
  // so the value is driven from the arg and written back, keeping the canvas
  // and the Controls panel in sync.
  render: function RenderSearchableSelect(args) {
    const [{ value }, updateArgs] = useArgs();
    return (
      <SearchableSelect
        {...args}
        value={value}
        onChange={(next) => updateArgs({ value: next })}
      />
    );
  },
};

export default meta;

type Story = StoryObj<typeof SearchableSelect>;

/** What the combobox's live region currently says. */
function status(canvasElement: HTMLElement): string {
  return (
    canvasElement.querySelector<HTMLElement>('[data-slot="combobox-status"]')
      ?.textContent ?? ""
  );
}

export const Empty: Story = {
  args: { value: "" },
};

export const WithSelection: Story = {
  args: { value: "claude-opus-4-8" },
};

export const Disabled: Story = {
  args: { value: "claude-opus-4-8", disabled: true },
};

export const WithError: Story = {
  args: { value: "", errorText: "Select a model" },
};

/**
 * Typing narrows the list to the matches, and the sticky escape hatch stays
 * on screen even when nothing matches.
 *
 * NOTE ON STATE: this story holds its value in `useState` rather than
 * `useArgs`, unlike the presentational stories above. `updateArgs`
 * round-trips through Storybook's manager channel, which the test runner does
 * not turn, so the arg never changes and the play function cannot observe the
 * selection it just made. `useArgs` is right for stories whose job is to
 * drive Controls; this one asserts its own state transition, so it owns the
 * state.
 */
export const TypeToFilter: Story = {
  args: { value: "" },
  render: function TypeToFilterSelect(args) {
    const [value, setValue] = useState(args.value);
    return <SearchableSelect {...args} value={value} onChange={setValue} />;
  },
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

    // Three rows are walkable but only two are matches, and the count is
    // what a screen reader hears: the pinned escape hatch must not be
    // counted as a result.
    await waitFor(() =>
      expect(status(canvasElement)).toContain("2 results are available"),
    );

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

    // The pinned row is still walkable, so the list is not empty, but nothing
    // matched and that is what is announced.
    await waitFor(() =>
      expect(status(canvasElement)).toContain("0 results are available"),
    );
  },
};
