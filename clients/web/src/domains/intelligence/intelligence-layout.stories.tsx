import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { Route, Routes } from "react-router";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { forceMobile } from "@/components/force-mobile-story-decorator";

import { IntelligenceLayout } from "./intelligence-layout";
import {
  OutletStub,
  phoneGlobals,
  withDetailIsScreen,
  withRegisteredPlus,
} from "./intelligence-layout-story-fixtures";

/**
 * Renders the real About Assistant drill-down chrome: section pages get a
 * back link to the overview plus the section heading; the overview itself
 * renders bare (it owns its full-bleed stage). Section stories start at a
 * representative path through `parameters.router`.
 *
 * The mobile stories cover the other chrome mode, where a section publishes
 * the complete top bar (back, title, action) instead of a body heading row:
 * the Contacts list, a contact detail whose back returns to that list, and
 * Library, which shares the recipe.
 */
const meta: Meta<typeof IntelligenceLayout> = {
  title: "Intelligence/IntelligenceLayout",
  component: IntelligenceLayout,
  // Opted out of the global `autodocs` tag. The mobile top bar is a
  // module-singleton slot, so on a docs page that mounts every story the last
  // layout to register would supply the bar shown above all of them.
  tags: ["!autodocs"],
};

export default meta;

type Story = StoryObj<typeof IntelligenceLayout>;

/** The desktop frame the section-chrome stories render inside. */
const inDesktopFrame: Decorator = function InDesktopFrame(Story) {
  return (
    <div style={{ height: 480, display: "flex", padding: "2rem" }}>
      <Story />
    </div>
  );
};

export const SectionChrome: Story = {
  parameters: { router: { initialEntries: ["/assistant/superpowers"] } },
  decorators: [inDesktopFrame],
};

/**
 * At a non-section path the layout renders bare — no back link, no heading —
 * and passes the outlet through untouched. A stub child route stands in for
 * the overview stage so the story renders visible content (an empty outlet
 * makes the story a blank page that can't distinguish working from broken).
 */
export const BareOverview: Story = {
  decorators: [inDesktopFrame],
  render: () => (
    <Routes>
      <Route element={<IntelligenceLayout />}>
        <Route
          index
          element={<OutletStub label="overview stage (outlet content)" />}
        />
      </Route>
    </Routes>
  ),
};

// ---------------------------------------------------------------------------
// Mobile top bar
// ---------------------------------------------------------------------------

/**
 * Lays the registered mobile top bar out in a row of its own, so these stories
 * stay about the layout and what it publishes. `intelligence-mobile-screens`
 * is where the same slot is read through the real `ChatLayoutHeader`; the row
 * here mirrors that header's mobile gutter so the two agree.
 */
function RegisteredMobileTopBar() {
  const mobileTopBar = useChatLayoutSlotsStore.use.mobileTopBar();
  if (mobileTopBar == null) {
    return null;
  }
  return (
    <div
      className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center px-4 max-md:px-3"
      style={{ minHeight: 40 }}
    >
      <div className="flex justify-start">{mobileTopBar.leading}</div>
      <div className="flex justify-center">{mobileTopBar.center}</div>
      <div className="flex justify-end">{mobileTopBar.trailing}</div>
    </div>
  );
}

/** The phone frame: the published top bar above the layout it came from. */
function MobileSectionChrome({ path, label }: { path: string; label: string }) {
  return (
    <div
      className="flex min-h-0 flex-col overflow-hidden bg-[var(--surface-overlay)]"
      style={{ height: 480 }}
    >
      <RegisteredMobileTopBar />
      <div className="flex min-h-0 flex-1 flex-col p-2">
        <Routes>
          <Route element={<IntelligenceLayout />}>
            <Route path={path} element={<OutletStub label={label} />} />
          </Route>
        </Routes>
      </div>
    </div>
  );
}

/** The Contacts list: back to the overview, the section title, and the plus. */
export const MobileContactsTopBar: Story = {
  parameters: {
    layout: "fullscreen",
    router: { initialEntries: ["/assistant/contacts"] },
  },
  globals: phoneGlobals,
  decorators: [withRegisteredPlus, forceMobile],
  render: () => (
    <MobileSectionChrome
      path="/assistant/contacts"
      label="contacts list (outlet content)"
    />
  ),
};

/** A contact detail, one level deeper: back reads "Back to Contacts". */
export const MobileContactDetailTopBar: Story = {
  parameters: {
    layout: "fullscreen",
    router: { initialEntries: ["/assistant/contacts/c_1"] },
  },
  globals: phoneGlobals,
  decorators: [withDetailIsScreen, forceMobile],
  render: () => (
    <MobileSectionChrome
      path="/assistant/contacts/:contactId"
      label="contact detail (outlet content)"
    />
  ),
};

/** Library, the other section that owns the bar, on the same recipe. */
export const MobileLibraryTopBar: Story = {
  parameters: {
    layout: "fullscreen",
    router: { initialEntries: ["/assistant/library"] },
  },
  globals: phoneGlobals,
  decorators: [forceMobile],
  render: () => (
    <MobileSectionChrome
      path="/assistant/library"
      label="library grid (outlet content)"
    />
  ),
};
