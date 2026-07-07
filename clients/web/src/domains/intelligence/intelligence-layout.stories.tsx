import type { Meta, StoryObj } from "@storybook/react-vite";

import { IntelligenceLayout } from "./intelligence-layout";

/**
 * Renders the real About Assistant chrome (heading + tab bar). The preview's
 * global `MemoryRouter` starts at `/`, so no tab is active until one is
 * clicked; there are no child routes, so the outlet below the tabs is empty.
 */
const meta: Meta<typeof IntelligenceLayout> = {
  title: "Intelligence/IntelligenceLayout",
  component: IntelligenceLayout,
  decorators: [
    (Story) => (
      <div style={{ height: 480, display: "flex", padding: "2rem" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof IntelligenceLayout>;

export const TabBar: Story = {};
