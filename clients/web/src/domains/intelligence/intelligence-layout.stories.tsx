import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Route, Routes } from "react-router";

import { Button } from "@vellumai/design-library";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { useIntelligenceLayoutSlotsStore } from "@/components/layout/intelligence-layout-slots-store";
import { forceMobile } from "@/components/force-mobile-story-decorator";

import { IntelligenceLayout } from "./intelligence-layout";

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

/** Stand-in for a section page, so a story renders visible outlet content. */
function OutletStub({ label }: { label: string }) {
  return (
    <div
      style={{
        display: "grid",
        placeItems: "center",
        height: "100%",
        width: "100%",
        border: "1px dashed var(--border-element)",
        borderRadius: 8,
        color: "var(--content-tertiary)",
      }}
    >
      {label}
    </div>
  );
}

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
 * Lays the registered mobile top bar out in the header's own row.
 * `ChatLayoutHeader` is what renders this slot in the app, and its story needs
 * a seeded chat session, which is why the row is drawn here instead.
 */
function RegisteredMobileTopBar() {
  const mobileTopBar = useChatLayoutSlotsStore.use.mobileTopBar();
  if (mobileTopBar == null) {
    return null;
  }
  return (
    <div
      className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center px-4"
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

/**
 * Publishes into the layout's slots store the way a section page does, and
 * clears the slot when the story unmounts. A `useState` initializer runs
 * during the decorator's own render, i.e. before the layout below it first
 * samples the store.
 */
function withSlot(publish: () => void, clear: () => void): Decorator {
  return function WithSlot(Story) {
    useState(publish);
    useEffect(() => clear, []);
    return <Story />;
  };
}

/**
 * Registers a circular plus in the layout's action slot, the way the Contacts
 * list registers its add affordance.
 */
const withRegisteredPlus = withSlot(
  () =>
    useIntelligenceLayoutSlotsStore
      .getState()
      .setHeaderTrailing(
        <Button
          shape="pill"
          variant="ghost"
          iconOnly={<Plus aria-hidden />}
          aria-label="Add contact"
          tooltip="Add contact"
          className="max-md:bg-[var(--surface-active)]"
        />,
      ),
  () => useIntelligenceLayoutSlotsStore.getState().setHeaderTrailing(null),
);

/**
 * Reports a pushed detail screen the way a section page does, which is what
 * aims the layout's Back at that section's list.
 */
const withDetailIsScreen = withSlot(
  () => useIntelligenceLayoutSlotsStore.getState().setDetailIsScreen(true),
  () => useIntelligenceLayoutSlotsStore.getState().setDetailIsScreen(false),
);

/** The phone viewport the mobile stories are drawn for, 390px wide. */
const phoneGlobals = {
  viewport: { value: "sbMobile", isRotated: false },
};

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
