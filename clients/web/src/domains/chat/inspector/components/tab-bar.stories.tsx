import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";

import { Tabs } from "@vellumai/design-library/components/tabs";

import { TABS, TabBar, isInspectorTab, type InspectorTab } from "./tab-bar";

/**
 * Stories for {@link TabBar}, the seven-tab row across the top of the
 * inspector's detail pane. The row is a `Tabs.List`, so the story mounts the
 * `Tabs.Root` and a panel the way `inspect-page` does, and puts a button on
 * either side: the row is one tab stop, Left/Right moves between tabs, and
 * Home/End jumps to the ends.
 */
const meta: Meta<{ selected: InspectorTab }> = {
  title: "Chat/Inspector/TabBar",
  component: TabBar,
  parameters: {
    layout: "fullscreen",
  },
  args: {
    selected: "overview",
  },
  argTypes: {
    selected: {
      control: "select",
      options: TABS.map((tab) => tab.id),
    },
  },
  // `TabBar` takes no props, so the one arg is the value on the surrounding
  // `Tabs.Root` and there is nothing to spread onto the component.
  render: function Render() {
    const [{ selected }, updateArgs] = useArgs<{ selected: InspectorTab }>();
    return (
      <div className="flex flex-col">
        <button type="button" className="self-start px-4 py-2">
          Focus starts here
        </button>
        <Tabs.Root
          value={selected}
          onValueChange={(next) => {
            if (isInspectorTab(next)) {
              updateArgs({ selected: next });
            }
          }}
        >
          <TabBar />
          {TABS.map(({ id, label }) => (
            <Tabs.Panel key={id} value={id} className="px-4 py-3">
              {label} panel
            </Tabs.Panel>
          ))}
        </Tabs.Root>
        <button type="button" className="self-start px-4 py-2">
          and continues here
        </button>
      </div>
    );
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The row as the inspector mounts it, with a button on either side so the
 * number of Tab presses it takes to cross the row is visible.
 */
export const Default: Story = {};

/**
 * A selection in the middle of the row, where arrow-key navigation has
 * somewhere to go in both directions.
 */
export const MiddleTabSelected: Story = {
  args: { selected: "raw" },
};
