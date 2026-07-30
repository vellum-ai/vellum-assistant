import type { Meta, StoryObj } from "@storybook/react-vite";
import { Navigate, Route, Routes } from "react-router";

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
        <Navigate to="/assistant/superpowers" replace />
        <Story />
      </>
    ),
  ],
};

/**
 * At a non-section path the layout renders bare — no back link, no heading —
 * and passes the outlet through untouched. A stub child route stands in for
 * the overview stage so the story renders visible content (an empty outlet
 * makes the story a blank page that can't distinguish working from broken).
 */
export const BareOverview: Story = {
  render: () => (
    <Routes>
      <Route element={<IntelligenceLayout />}>
        <Route
          index
          element={
            <div
              style={{
                display: "grid",
                placeItems: "center",
                height: "100%",
                width: "100%",
                border: "1px dashed var(--border-default)",
                borderRadius: 8,
                color: "var(--content-tertiary)",
              }}
            >
              overview stage (outlet content)
            </div>
          }
        />
      </Route>
    </Routes>
  ),
};
