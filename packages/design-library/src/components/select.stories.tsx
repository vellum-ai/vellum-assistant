import type { Meta, StoryObj } from "@storybook/react-vite";
import { Globe, Lock, Users } from "lucide-react";
import { useState } from "react";
import { useArgs } from "storybook/preview-api";
import { expect, userEvent, within } from "storybook/test";

import { Select, type SelectOption } from "./select";
import { Modal } from "./modal";
import { Tag } from "./tag";

// Deliberately the same fixtures as `dropdown.stories.tsx`, so the two entries
// can be flipped between in the sidebar to compare them directly.
const fruits: SelectOption<string>[] = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "cherry", label: "Cherry" },
  { value: "dragonfruit", label: "Dragonfruit" },
  { value: "elderberry", label: "Elderberry" },
];

const visibilityOptions: SelectOption<string>[] = [
  { value: "public", label: "Public", icon: <Globe className="h-4 w-4" /> },
  { value: "team", label: "Team only", icon: <Users className="h-4 w-4" /> },
  { value: "private", label: "Private", icon: <Lock className="h-4 w-4" /> },
];

const machineSizes: SelectOption<string>[] = [
  {
    value: "small",
    label: "Small, 2 vCPU, 3 GiB",
    suffix: <Tag tone="positive">Current</Tag>,
  },
  { value: "medium", label: "Medium, 2.5 vCPU, 5 GiB" },
  { value: "large", label: "Large, 4 vCPU, 8 GiB" },
];

const manyOptions: SelectOption<string>[] = Array.from(
  { length: 20 },
  (_, i) => ({ value: `option-${i + 1}`, label: `Option ${i + 1}` }),
);

const meta: Meta<typeof Select> = {
  title: "Components/Select",
  component: Select,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component: [
          "Single-select control for choosing one **value** from a list.",
          "",
          "Use `Menu` instead when the list contains **actions** (Rename, Duplicate, Delete).",
          "Both visually drop down, but they are different controls with different semantics.",
          "",
          "**This replaces `Dropdown`.** The two render identically; this one is a thin",
          "wrapper over Radix Select rather than hand-rolled positioning, keyboard",
          "navigation, outside-click and focus management.",
          "",
          "Two behaviour differences when migrating from `Dropdown`: re-selecting the",
          "value that is already selected does **not** call `onChange` (this reports",
          "changes, `Dropdown` fired on every click), and an option may not carry an",
          "empty-string `value`. See the `Dropdown` page and LUM-2959.",
        ].join("\n"),
      },
    },
  },
  args: {
    options: fruits,
    value: "apple",
    "aria-label": "Fruit",
  },
  argTypes: {
    placeholder: { control: "text" },
    disabled: { control: "boolean" },
    size: { control: "inline-radio", options: ["regular", "compact"] },
    menuAlign: { control: "select", options: ["start", "end"] },
    menuMaxHeight: { control: "number" },
    menuMinWidth: { control: "number" },
    "aria-label": { control: "text" },
    options: { control: false },
    onChange: { control: false },
  },
  // Shared by every presentational story: `Select` is controlled, so the value
  // is driven from the arg and written back, keeping the canvas and the
  // Controls panel in sync.
  render: function RenderSelect(args) {
    const [{ value }, updateArgs] = useArgs();
    return (
      <div className="w-64">
        <Select
          {...args}
          value={value}
          onChange={(next) => updateArgs({ value: next })}
        />
      </div>
    );
  },
};

export default meta;
type Story = StoryObj<typeof Select>;

export const Default: Story = {};

export const WithPlaceholder: Story = {
  args: { value: "", placeholder: "Select a fruit…" },
};

export const WithIcons: Story = {
  args: {
    options: visibilityOptions,
    value: "public",
    "aria-label": "Visibility",
  },
};

export const Disabled: Story = {
  args: { disabled: true, value: "banana" },
};

export const LongList: Story = {
  args: {
    options: manyOptions,
    value: "option-1",
    menuMaxHeight: 200,
    "aria-label": "Option",
  },
};

export const EndAligned: Story = {
  args: { menuAlign: "end" },
  render: function EndAlignedSelect(args) {
    const [{ value }, updateArgs] = useArgs();
    return (
      <div className="flex w-96 justify-end">
        <div className="w-48">
          <Select
            {...args}
            value={value}
            onChange={(next) => updateArgs({ value: next })}
          />
        </div>
      </div>
    );
  },
};

export const WithSuffix: Story = {
  args: {
    options: machineSizes,
    value: "small",
    "aria-label": "Machine size",
  },
  render: function SuffixSelect(args) {
    const [{ value }, updateArgs] = useArgs();
    return (
      <div className="w-80">
        <Select
          {...args}
          value={value}
          onChange={(next) => updateArgs({ value: next })}
        />
      </div>
    );
  },
};

export const Compact: Story = {
  args: { size: "compact" },
  render: function CompactSelect(args) {
    const [{ value }, updateArgs] = useArgs();
    return (
      <div className="w-48">
        <Select
          {...args}
          value={value}
          onChange={(next) => updateArgs({ value: next })}
        />
      </div>
    );
  },
};

export const InsideTransformedAncestor: Story = {
  args: { value: "apple", "aria-label": "Fruit" },
  render: function TransformedAncestorSelect(args) {
    const [{ value }, updateArgs] = useArgs();
    return (
      <div style={{ transform: "translate(80px, 40px)" }}>
        <div className="w-64">
          <Select
            {...args}
            options={fruits}
            value={value}
            onChange={(next) => updateArgs({ value: next })}
          />
        </div>
      </div>
    );
  },
  play: async ({ canvasElement, step }) => {
    const trigger = within(canvasElement).getByRole("combobox", {
      name: "Fruit",
    });
    await step("menu tracks its trigger", async () => {
      await userEvent.click(trigger);
      const menu = document.querySelector('[data-slot="select-menu"]');
      await expect(menu).not.toBeNull();
      const menuRect = menu!.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      await expect(Math.abs(menuRect.left - triggerRect.left)).toBeLessThan(1);
      await expect(menuRect.top).toBeGreaterThanOrEqual(triggerRect.bottom);
    });
  },
};

/**
 * A trigger low in the viewport opens upward. `Dropdown` always opens
 * downward, so the same trigger puts its menu below the fold.
 */
export const OpensUpwardWhenLow: Story = {
  args: { value: "apple", "aria-label": "Fruit" },
  parameters: { layout: "fullscreen" },
  render: function LowSelect(args) {
    const [{ value }, updateArgs] = useArgs();
    return (
      <div className="flex h-screen flex-col justify-end p-4">
        <div className="w-64">
          <Select
            {...args}
            options={fruits}
            value={value}
            onChange={(next) => updateArgs({ value: next })}
          />
        </div>
      </div>
    );
  },
  play: async ({ canvasElement, step }) => {
    const trigger = within(canvasElement).getByRole("combobox", {
      name: "Fruit",
    });
    await step("menu flips above and stays on screen", async () => {
      await userEvent.click(trigger);
      const menu = document.querySelector('[data-slot="select-menu"]');
      await expect(menu).not.toBeNull();
      const menuRect = menu!.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      await expect(menuRect.bottom).toBeLessThanOrEqual(triggerRect.top + 1);
      await expect(menuRect.top).toBeGreaterThanOrEqual(0);
    });
  },
};

/**
 * NOTE ON STATE: this story holds its value in `useState` rather than
 * `useArgs`, unlike the presentational stories above.
 *
 * `updateArgs` round-trips through Storybook's manager channel, which does not
 * exist in the Playwright test runner, so the arg never changes and the play
 * function cannot observe the selection it just made. Verified: after clicking
 * an option the trigger still reads the placeholder. `useArgs` is right for
 * stories whose job is to drive Controls; these two exist purely as regression
 * guards, so they own their state.
 */
/**
 * Clearing the value from the parent returns the trigger to its placeholder.
 *
 * Worth pinning because it is easy to break: Radix decides controlled versus
 * uncontrolled by whether `value` is `undefined`, so translating the empty
 * string to `undefined` would hand control back to Radix at exactly the moment
 * a caller resets, leaving the previous choice on screen.
 */
export const ClearedByParent: Story = {
  args: { value: "",
    placeholder: "Select a fruit…",
    "aria-label": "Fruit",
  },
  render: function ClearableSelect(args) {
    const [value, setValue] = useState<string>("");
    return (
      <div className="flex w-64 flex-col gap-2">
        <Select {...args} options={fruits} value={value}
          onChange={setValue} />
        <button type="button" data-testid="clear" onClick={() => setValue("")}>
          Clear
        </button>
      </div>
    );
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("combobox", { name: "Fruit" });

    await step("user picks an option", async () => {
      await userEvent.click(trigger);
      const cherry = [
        ...document.querySelectorAll<HTMLElement>('[data-slot="select-option"]'),
      ].find((o) => o.textContent?.includes("Cherry"));
      await expect(cherry).toBeDefined();
      await userEvent.click(cherry!);
      await expect(trigger.textContent).toContain("Cherry");
    });

    await step("parent clears it back to the placeholder", async () => {
      await userEvent.click(canvas.getByTestId("clear"));
      await expect(trigger.textContent).toContain("Select a fruit…");
      await expect(trigger.textContent).not.toContain("Cherry");
    });
  },
};

/**
 * NOTE ON STATE: this story holds its value in `useState` rather than
 * `useArgs`, unlike the presentational stories above.
 *
 * `updateArgs` round-trips through Storybook's manager channel, which does not
 * exist in the Playwright test runner, so the arg never changes and the play
 * function cannot observe the selection it just made. Verified: after clicking
 * an option the trigger still reads the placeholder. `useArgs` is right for
 * stories whose job is to drive Controls; these two exist purely as regression
 * guards, so they own their state.
 */
/**
 * Inside a modal the menu is portaled out of the dialog, so it must still be
 * clickable under the dialog's `pointer-events: none` on `body`, and choosing
 * an option must not read as an outside click and dismiss the modal.
 */
export const InsideModal: Story = {
  args: { value: "apple", "aria-label": "Fruit" },
  render: function ModalSelect(args) {
    const [value, setValue] = useState<string>("apple");
    return (
      <Modal.Root>
        <Modal.Trigger asChild>
          <button type="button" data-testid="open-modal">
            Open modal
          </button>
        </Modal.Trigger>
        <Modal.Content>
          <Modal.Header>
            <Modal.Title>Pick a fruit</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <div className="w-64">
              <Select
                {...args}
                options={fruits}
                value={value}
                onChange={setValue}
              />
            </div>
          </Modal.Body>
        </Modal.Content>
      </Modal.Root>
    );
  },
  play: async ({ canvasElement, step }) => {
    await userEvent.click(within(canvasElement).getByTestId("open-modal"));
    const dialog = document.querySelector('[data-slot="modal-content"]');
    await expect(dialog).not.toBeNull();
    const trigger = document.querySelector<HTMLElement>(
      '[data-slot="select-trigger"]',
    );

    await step("menu escapes the dialog and stays clickable", async () => {
      await userEvent.click(trigger!);
      const menu = document.querySelector<HTMLElement>(
        '[data-slot="select-menu"]',
      );
      await expect(menu).not.toBeNull();
      await expect(dialog!.contains(menu)).toBe(false);
      await expect(getComputedStyle(menu!).pointerEvents).toBe("auto");
    });

    await step("choosing an option does not dismiss the modal", async () => {
      const cherry = [
        ...document.querySelectorAll<HTMLElement>('[data-slot="select-option"]'),
      ].find((o) => o.textContent?.includes("Cherry"));
      await userEvent.click(cherry!);
      await expect(trigger!.textContent).toContain("Cherry");
      await expect(
        document.querySelector('[data-slot="modal-content"]'),
      ).not.toBeNull();
    });
  },
};
