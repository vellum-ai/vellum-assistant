import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";

import { FilterChip } from "./filter-chip";

const meta: Meta<typeof FilterChip> = {
  title: "Components/FilterChip",
  component: FilterChip,
  args: {
    children: "Finance",
    selected: false,
    count: 9,
    disabled: false,
  },
  argTypes: {
    children: { control: "text" },
    count: { control: "number" },
  },
};

export default meta;

type Story = StoryObj<typeof FilterChip>;

/** Arg-driven: a click writes `selected` back so the canvas and Controls agree. */
export const Default: Story = {
  render: function Render(args) {
    const [{ selected }, updateArgs] = useArgs();
    return (
      <FilterChip
        {...args}
        selected={selected}
        onClick={() => updateArgs({ selected: !selected })}
      />
    );
  },
};

/** No count: the chip is the label alone. */
export const WithoutCount: Story = {
  args: { count: undefined },
};

export const Disabled: Story = {
  args: { disabled: true },
};

const CATEGORIES = [
  { key: "productivity", label: "Productivity", count: 14 },
  { key: "communication", label: "Communication", count: 4 },
  { key: "meetings", label: "Meetings", count: 6 },
  { key: "sales", label: "Sales & CRM", count: 5 },
  { key: "marketing", label: "Marketing", count: 7 },
  { key: "finance", label: "Finance", count: 9 },
  { key: "engineering", label: "Engineering", count: 6 },
];

/**
 * A single-select row under a search field, the use the chip is sized for.
 * Owns its state locally so the interaction can be exercised in a `play`
 * function; clicking the selected chip clears the filter.
 */
export const SingleSelectRow: Story = {
  parameters: { controls: { disable: true } },
  render: function Render() {
    const [selected, setSelected] = useState<string | null>("finance");
    return (
      <div className="flex max-w-xl gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
        {CATEGORIES.map((category) => (
          <FilterChip
            key={category.key}
            selected={selected === category.key}
            count={category.count}
            onClick={() =>
              setSelected(selected === category.key ? null : category.key)
            }
          >
            {category.label}
          </FilterChip>
        ))}
      </div>
    );
  },
};
