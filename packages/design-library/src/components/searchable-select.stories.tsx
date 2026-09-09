import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { useArgs } from "storybook/preview-api";
import { expect, screen, userEvent, waitFor } from "storybook/test";

import {
  SearchableSelect,
  type SearchableSelectOption,
  type SearchableSelectProps,
} from "./searchable-select";

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
 * The same list disclosed progressively: one section per vendor, the older
 * version of a line folded away behind the row that unfolds it.
 */
const GROUPED_MODELS: SearchableSelectOption[] = [
  { value: "claude-opus-4-8", label: "Claude Opus 4.8", group: "Anthropic" },
  { value: "claude-fable-5", label: "Claude Fable 5", group: "Anthropic" },
  {
    value: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    group: "Anthropic",
    folded: true,
  },
  {
    value: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    group: "Anthropic",
    folded: true,
  },
  {
    value: "__older-anthropic__",
    label: "Show older versions (2)",
    group: "Anthropic",
    listAction: true,
  },
  { value: "gpt-5-6", label: "GPT-5.6", group: "OpenAI" },
  { value: "gpt-5-6-mini", label: "GPT-5.6 Mini", group: "OpenAI" },
  { value: "gemini-3-pro", label: "Gemini 3 Pro", group: "Google Gemini" },
  { value: "gemini-3-flash", label: "Gemini 3 Flash", group: "Google Gemini" },
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

/**
 * Vendors whose names an `uppercase` transform would spell wrong, and enough
 * of them to make the list scroll past its own headings.
 */
const BRAND_MODELS: SearchableSelectOption[] = [
  { value: "grok-4-6", label: "Grok 4.6", group: "xAI" },
  { value: "grok-4-6-fast", label: "Grok 4.6 Fast", group: "xAI" },
  { value: "glm-5-2", label: "GLM 5.2", group: "Z.ai" },
  { value: "glm-5-2-air", label: "GLM 5.2 Air", group: "Z.ai" },
  { value: "minimax-m3", label: "MiniMax M3", group: "MiniMax" },
  { value: "minimax-m2-her", label: "MiniMax M2-her", group: "MiniMax" },
  { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro", group: "DeepSeek" },
  { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash", group: "DeepSeek" },
  { value: "deepseek-r1", label: "DeepSeek R1", group: "DeepSeek" },
  { value: "kimi-k3", label: "Kimi K3", group: "Moonshot AI" },
  { value: "kimi-k2-thinking", label: "Kimi K2 Thinking", group: "Moonshot AI" },
  { value: "llama-4-maverick", label: "Llama 4 Maverick", group: "Meta" },
  { value: "llama-4-scout", label: "Llama 4 Scout", group: "Meta" },
  { value: "__custom__", label: "Enter a custom model ID…", sticky: true },
];

/**
 * Shared by the two grouped stories. The state a `listAction` row toggles
 * belongs to the caller, so it is owned here rather than through args, and a
 * revealed row is marked `disclosed` so the list can set the revealed block
 * off from what was already there.
 */
function RenderGrouped(args: SearchableSelectProps) {
  const [value, setValue] = useState("");
  const [unfolded, setUnfolded] = useState(false);
  const options = unfolded
    ? GROUPED_MODELS.map((option) => {
        if (option.listAction) {
          // Kept once the section is open, so the same control closes it.
          return { ...option, label: "Show fewer", expanded: true };
        }
        return option.folded
          ? { ...option, folded: false, disclosed: true }
          : option;
      })
    : GROUPED_MODELS;
  return (
    <SearchableSelect
      {...args}
      options={options}
      value={value}
      onChange={(next) => {
        if (next === "__older-anthropic__") {
          setUnfolded((previous) => !previous);
          return;
        }
        setValue(next);
      }}
    />
  );
}

/**
 * Sections and progressive disclosure. Headings come from each row's `group`,
 * in the order their first row appears; a `folded` row waits for a query or
 * for the `listAction` row that stands in for it, which sits on the section's
 * heading and is the one row a pick leaves the list open on.
 *
 * The state a `listAction` row toggles belongs to the caller, so this story
 * owns it locally rather than through args.
 */
export const Grouped: Story = {
  args: { value: "" },
  parameters: { controls: { disable: true } },
  render: RenderGrouped,
  play: async ({ canvasElement }) => {
    const field = canvasElement.querySelector<HTMLInputElement>(
      'input[role="combobox"]',
    );
    if (!field) {
      throw new Error("expected the combobox field");
    }
    await userEvent.click(field);
    await waitFor(() =>
      expect(
        screen.getAllByRole("option").map((option) => option.textContent),
      ).not.toContain("Claude Opus 4.7"),
    );

    // The unfold row is an action on the list, not an answer to it: it says
    // so with `aria-expanded` and is drawn as a secondary action.
    const unfold = await screen.findByRole("option", {
      name: "Show older versions (2)",
    });
    expect(unfold.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(unfold);

    // The list stays open on the control that acted on it, the folded rows
    // join the section, and the control now says it can close it again.
    await waitFor(() => {
      const labels = screen
        .getAllByRole("option")
        .map((option) => option.textContent);
      expect(labels).toContain("Claude Opus 4.7");
    });
    expect(
      (await screen.findByRole("option", { name: "Show fewer" })).getAttribute(
        "aria-expanded",
      ),
    ).toBe("true");
  },
};

/**
 * The same list with its older versions already revealed, which is the state
 * the hairline is for: the block a list action opened is set off from the
 * rows that were there before it.
 */
/**
 * Headings whose own capitalisation is the point, in a list long enough to
 * scroll: nothing transforms the letters, and each heading stays pinned to
 * the top of the list while its own rows are still on screen.
 */
export const GroupedStickyHeadings: Story = {
  args: { value: "", options: BRAND_MODELS },
  parameters: { controls: { disable: true } },
  render: function RenderSticky(args) {
    const [value, setValue] = useState("");
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
    await waitFor(() =>
      expect(screen.getByText("xAI").textContent).toBe("xAI"),
    );
  },
};

export const GroupedDisclosed: Story = {
  args: { value: "" },
  parameters: { controls: { disable: true } },
  render: RenderGrouped,
  play: async ({ canvasElement }) => {
    const field = canvasElement.querySelector<HTMLInputElement>(
      'input[role="combobox"]',
    );
    if (!field) {
      throw new Error("expected the combobox field");
    }
    await userEvent.click(field);
    await userEvent.click(await screen.findByText("Show older versions (2)"));
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Claude Opus 4\.7/ })).toBeTruthy(),
    );
  },
};
