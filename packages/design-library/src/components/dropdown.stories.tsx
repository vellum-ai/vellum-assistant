import type { Meta, StoryObj } from "@storybook/react-vite";
import { Globe, Lock, Users } from "lucide-react";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";

import { Dropdown, type DropdownOption } from "./dropdown";
import { Modal } from "./modal";
import { Tag } from "./tag";

const fruits: DropdownOption<string>[] = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "cherry", label: "Cherry" },
  { value: "dragonfruit", label: "Dragonfruit" },
  { value: "elderberry", label: "Elderberry" },
];

const meta: Meta<typeof Dropdown> = {
  title: "Components/Dropdown",
  component: Dropdown,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component: [
          "> **Deprecated. Use [`Select`](/docs/components-select--docs) instead.**",
          ">",
          "> `Select` renders identically, but check two behaviour differences",
          "> before moving a call site:",
          ">",
          "> 1. **Re-selecting the current value does not call `onChange`.**",
          ">    `Dropdown` fires on every click; `Select` reports *changes*, so",
          ">    picking the option that is already selected is silent. A call site",
          ">    that treats the click itself as a signal (pinning an inherited",
          ">    default, re-triggering a fetch, marking a form dirty) needs a local",
          ">    change, not just an import swap. At least one caller depends on this",
          ">    today; tracked on LUM-2959.",
          "> 2. **Options may not carry an empty-string `value`**, which Radix",
          ">    reserves to mean \"cleared\". Use `placeholder`, or a real sentinel.",
          ">",
          "> **Why:** this component hand-rolls its own positioning, keyboard",
          "> navigation, outside-click handling and focus management. `Select` is a",
          "> thin wrapper over Radix Select, which is what every other overlay in",
          "> this package already uses.",
          ">",
          "> **What you get by moving:** the menu flips upward when the trigger sits",
          "> low in the viewport (this one always opens downward, below the fold),",
          "> and it cannot be captured by an ancestor `transform`.",
          ">",
          "> No rush per call site. Move them as you touch the files; this component",
          "> stays until the last one is gone.",
        ].join("\n"),
      },
    },
  },
  argTypes: {
    placeholder: { control: "text" },
    disabled: { control: "boolean" },
    size: { control: "inline-radio", options: ["regular", "compact"] },
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
type Story = StoryObj<typeof Dropdown>;

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

const visibilityOptions: DropdownOption<string>[] = [
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
    const [value, setValue] = useState("public");
    return (
      <div className="w-64">
        <Dropdown
          {...args}
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

const machineSizes: DropdownOption<string>[] = [
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
    const [value, setValue] = useState("small");
    return (
      <div className="w-80">
        <Dropdown
          {...args}
          options={machineSizes}
          value={value}
          onChange={setValue}
        />
      </div>
    );
  },
};

export const Compact: Story = {
  args: {
    size: "compact",
    "aria-label": "Fruit",
  },
  render: function CompactDropdown(args) {
    const [value, setValue] = useState("apple");
    return (
      <div className="w-48">
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

/**
 * Regression guard: the menu must stay glued to its trigger even when an
 * ancestor has a `transform`.
 *
 * A transformed ancestor becomes the containing block for `position: fixed`
 * descendants, so a menu rendered inline under one resolves its viewport
 * coordinates against that ancestor's box instead, shifting it by the
 * ancestor's origin, usually far enough to leave the viewport entirely. The
 * trigger still reports `data-state="open"`, which is why the failure reads to
 * users as "the dropdown won't open" rather than "the menu is in the wrong
 * place". Portaling the menu out of the transformed subtree is what keeps the
 * viewport as its containing block.
 *
 * The web app hits this with its detail drawer, whose slide-in animation uses
 * `animation-fill-mode: both`, so the final keyframe's identity matrix stays
 * applied for the life of the drawer.
 */
export const InsideTransformedAncestor: Story = {
  args: {
    "aria-label": "Fruit",
  },
  render: function TransformedAncestorDropdown(args) {
    const [value, setValue] = useState("apple");
    return (
      // `translate(80px, 40px)` stands in for the drawer's leftover matrix. A
      // non-zero offset is deliberate: an identity transform triggers the same
      // containing-block switch but hides the resulting drift behind a zero
      // delta, so the assertion below would pass even on the broken build.
      <div style={{ transform: "translate(80px, 40px)" }}>
        <div className="w-64">
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
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("combobox", { name: "Fruit" });

    await step("open the menu", async () => {
      await userEvent.click(trigger);
      await expect(trigger).toHaveAttribute("data-state", "open");
    });

    await step("menu is positioned against the viewport", async () => {
      // Scoped to the document, not the canvas: the menu is portaled out of
      // the story's subtree, which is the whole point of this story.
      const menu = document.querySelector('[data-slot="dropdown-menu"]');
      await expect(menu).not.toBeNull();

      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu!.getBoundingClientRect();

      // Left-aligned (the default) and directly below the trigger. Sub-pixel
      // layout rounding is the only slack; the transformed-ancestor bug
      // offsets these by the ancestor's translate (80px / 40px).
      await expect(Math.abs(menuRect.left - triggerRect.left)).toBeLessThan(1);
      await expect(menuRect.top).toBeGreaterThanOrEqual(triggerRect.bottom);
      await expect(menuRect.top - triggerRect.bottom).toBeLessThan(8);
    });
  },
};

/**
 * Regression guard for the riskiest consequence of portaling the menu to
 * `document.body`: inside a modal, the menu is no longer a DOM descendant of
 * the dialog it belongs to.
 *
 * Two things could break as a result, and this story pins both.
 *
 * 1. Dismissal. Radix's `DismissableLayer` decides what counts as an outside
 *    click from a React `onPointerDownCapture` on the layer. `createPortal`
 *    preserves React-tree parentage even though DOM parentage moves, so an
 *    option click still reads as inside the dialog. If that ever stopped
 *    holding, selecting an option would close the modal out from under the
 *    user.
 * 2. Clickability. Radix marks `body` with `pointer-events: none` in modal
 *    mode, so a menu parented to `body` inherits it. The menu carries
 *    `pointer-events-auto` for exactly this reason, and losing that class
 *    would make every option silently unclickable.
 */
export const InsideModal: Story = {
  args: {
    "aria-label": "Fruit",
  },
  render: function ModalDropdown(args) {
    const [value, setValue] = useState("apple");
    return (
      // Opened by the play function rather than `defaultOpen`. An always-open
      // modal renders over the whole autodocs page, hiding every other story.
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
              <Dropdown
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

    // Scoped to the document rather than the canvas: both the dialog and the
    // menu are portaled out of the story's subtree.
    const dialog = document.querySelector('[data-slot="modal-content"]');
    await expect(dialog).not.toBeNull();

    const trigger = document.querySelector<HTMLElement>(
      '[data-slot="dropdown-trigger"]',
    );
    await expect(trigger).not.toBeNull();

    await step("menu opens and escapes the dialog in the DOM", async () => {
      await userEvent.click(trigger!);
      const menu = document.querySelector('[data-slot="dropdown-menu"]');
      await expect(menu).not.toBeNull();
      await expect(dialog!.contains(menu)).toBe(false);
    });

    await step("options stay clickable under modal pointer-events", async () => {
      const menu = document.querySelector<HTMLElement>(
        '[data-slot="dropdown-menu"]',
      );
      await expect(getComputedStyle(menu!).pointerEvents).toBe("auto");
    });

    await step("selecting an option does not dismiss the modal", async () => {
      const options = document.querySelectorAll<HTMLElement>(
        '[data-slot="dropdown-option"]',
      );
      const cherry = [...options].find((o) => o.textContent?.includes("Cherry"));
      await expect(cherry).toBeDefined();
      await userEvent.click(cherry!);

      await expect(trigger!.textContent).toContain("Cherry");
      await expect(
        document.querySelector('[data-slot="modal-content"]'),
      ).not.toBeNull();
    });
  },
};
