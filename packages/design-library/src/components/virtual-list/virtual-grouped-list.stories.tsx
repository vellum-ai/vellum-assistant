import { type ReactNode } from "react";

import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  VirtualGroupedList,
  type VirtualListGroup,
} from "./virtual-grouped-list";

const meta: Meta<typeof VirtualGroupedList> = {
  title: "Components/VirtualList/VirtualGroupedList",
  component: VirtualGroupedList,
  parameters: { layout: "centered" },
};

export default meta;

type Story = StoryObj<typeof VirtualGroupedList>;

function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        height: 480,
        width: 320,
        overflow: "hidden",
        borderRadius: 12,
        border: "1px solid var(--border-base)",
        background: "var(--surface-base)",
      }}
    >
      {children}
    </div>
  );
}

function makeItems(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);
}

const GROUPS: VirtualListGroup<string>[] = [
  { key: "today", label: "Today", items: makeItems("Conversation", 6) },
  {
    key: "yesterday",
    label: "Yesterday",
    collapsible: true,
    items: makeItems("Conversation", 5),
  },
  {
    key: "last-week",
    label: "Last 7 days",
    collapsible: true,
    items: makeItems("Conversation", 12),
  },
  {
    key: "older",
    label: "Older",
    collapsible: true,
    defaultCollapsed: true,
    items: makeItems("Conversation", 40),
  },
];

function Item({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-2 text-body-medium-default text-[color:var(--content-secondary)]">
      {children}
    </div>
  );
}

/** Sticky section headers (default). The "Older" group seeds collapsed; click a
 *  collapsible header to toggle it. */
export const Default: Story = {
  render: () => (
    <Frame>
      <VirtualGroupedList<string>
        className="h-full"
        groups={GROUPS}
        computeItemKey={(_index, item) => item}
        itemContent={(_index, item) => <Item>{item}</Item>}
      />
    </Frame>
  ),
};

/** `stickyHeaders={false}` — headers scroll away with their items instead of
 *  pinning to the top. */
export const NonSticky: Story = {
  render: () => (
    <Frame>
      <VirtualGroupedList<string>
        className="h-full"
        groups={GROUPS}
        stickyHeaders={false}
        computeItemKey={(_index, item) => item}
        itemContent={(_index, item) => <Item>{item}</Item>}
      />
    </Frame>
  ),
};

/** A custom `groupHeader` render prop replacing the default header. */
export const CustomHeader: Story = {
  render: () => (
    <Frame>
      <VirtualGroupedList<string>
        className="h-full"
        groups={GROUPS}
        computeItemKey={(_index, item) => item}
        groupHeader={(group, collapsed, toggle) => (
          <button
            type="button"
            onClick={toggle}
            disabled={!group.collapsible}
            className="flex w-full items-center justify-between bg-[var(--surface-lift)] px-4 py-2 text-label-small-default text-[color:var(--content-emphasised)]"
          >
            <span>{group.label.toUpperCase()}</span>
            {group.collapsible ? (
              <span className="text-[color:var(--content-tertiary)]">
                {collapsed ? "+" : "−"}
              </span>
            ) : null}
          </button>
        )}
        itemContent={(_index, item) => <Item>{item}</Item>}
      />
    </Frame>
  ),
};
