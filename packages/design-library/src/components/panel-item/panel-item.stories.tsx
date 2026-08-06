import { LayoutGrid, Plus, Settings } from "lucide-react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { PanelItem } from "./panel-item";

/**
 * The navigation row primitive: sidebars, settings nav, admin trees.
 *
 * `shape` is the only geometry switch. A pill is the same row with a capsule
 * radius, content-hugging width, and a resting surface, so hover, active
 * state, badges, and trailing actions behave identically either way.
 *
 * Rows are pinned to a narrow column here because that is the context they
 * ship in, and because a full-width row and a content-hugging pill only read
 * differently when there is a column edge to sit against.
 */
const meta: Meta<typeof PanelItem> = {
  title: "Components/PanelItem",
  component: PanelItem,
  args: {
    label: "Conversations",
    shape: "row",
  },
  argTypes: {
    shape: { control: "inline-radio", options: ["row", "pill"] },
    activeVariant: { control: "inline-radio", options: ["default", "branded"] },
    label: { control: "text" },
    active: { control: "boolean" },
    marqueeOnHover: { control: "boolean" },
    disabled: { control: "boolean" },
    // Slots and handlers: a component, a node, or a function, none of which a
    // Controls field can produce. Autodocs surfaces them otherwise.
    icon: { control: false },
    leadingSlot: { control: false },
    expandChevron: { control: false },
    badge: { control: false },
    trailingAction: { control: false },
    onSelect: { control: false },
    children: { control: false },
    ref: { control: false },
  },
  globals: {
    viewport: { value: "sbDesktop", isRotated: false },
  },
  parameters: {
    viewport: {
      options: {
        sbDesktop: {
          name: "Desktop",
          styles: { width: "1280px", height: "760px" },
          type: "desktop",
        },
      },
    },
    /* PanelItem carries `max-md:` variants for mobile drawers (16px type at
       44px tall instead of 14px at 32px), and those key off the *viewport*.
       The Canvas iframe is far narrower than the browser window, so without
       a pinned viewport these stories silently document the mobile metrics.
       Read them in Canvas; a Docs page shares one iframe and cannot honor
       this. */
  },
  decorators: [
    (Story) => (
      <div style={{ width: 248 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof PanelItem>;

/** Arg-driven: flip `shape` and `active` from the Controls panel. */
export const Default: Story = {
  args: { icon: LayoutGrid, onSelect: () => {} },
};

/**
 * The two shapes in the same stretching column, which is the comparison that
 * matters: the parent here does nothing to shrink its children, so a row fills
 * the 248px column and a pill sizes to its label on its own.
 */
export const Shapes: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <PanelItem shape="row" icon={LayoutGrid} label="Row" onSelect={() => {}} />
      <PanelItem
        shape="pill"
        icon={LayoutGrid}
        label="Pill"
        onSelect={() => {}}
      />
    </div>
  ),
};

/**
 * A pill carries selected state exactly as a row does.
 *
 * The column deliberately stretches its children rather than setting
 * `align-items: flex-start`: a shrink-wrapping parent would size these pills
 * from the outside and hide whether the shape does it itself.
 */
export const PillStates: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
      }}
    >
      <PanelItem shape="pill" icon={Plus} label="New Chat" onSelect={() => {}} />
      <PanelItem
        shape="pill"
        icon={LayoutGrid}
        label="Memory"
        onSelect={() => {}}
      />
      <PanelItem
        shape="pill"
        icon={LayoutGrid}
        label="Memory"
        active
        onSelect={() => {}}
      />
      {/* No badge: nothing in the sidebar puts a count on a pill, and a
          fabricated one would document an affordance the product does not
          have. `badge` is covered by the badge tests. */}
      <PanelItem
        shape="pill"
        icon={Settings}
        label="Preferences"
        onSelect={() => {}}
      />
    </div>
  ),
};
