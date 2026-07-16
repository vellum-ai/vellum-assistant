import type { Meta, StoryObj } from "@storybook/react-vite";
import { Navigate } from "react-router";

import { IntelligenceLayout } from "./intelligence-layout";

/**
 * Renders the real About Assistant drill-down chrome: section pages get a
 * back link to the overview plus the section heading; the overview itself
 * renders bare (it owns its full-bleed stage). The preview's global
 * `MemoryRouter` starts at `/`, so section stories redirect to a
 * representative path via `<Navigate>`; there are no child routes, so the
 * outlet is empty.
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

export const SectionChrome: Story = {
  decorators: [
    (Story) => (
      <>
        <Navigate to="/assistant/skills" replace />
        <Story />
      </>
    ),
  ],
};

/** At a non-section path the layout renders bare — an empty outlet here. */
export const BareOverview: Story = {};
