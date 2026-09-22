/**
 * The mobile About Assistant screens as the app assembles them: a page fills
 * `IntelligenceLayout`'s slots, the layout publishes the complete mobile top
 * bar, and the real `ChatLayoutHeader` renders it above the page body.
 *
 * One story per destination below the assistant overview, so the set reads as
 * a walk through the phone's About Assistant: every one carries the same back
 * pill, centered title, and optional trailing action, and no page under them
 * draws a back control of its own. Bodies are stand-ins except where a cheap
 * fixture exists; the bar is what these stories are for.
 *
 * `intelligence-layout.stories.tsx` reads the layout on its own, with a
 * stand-in row for the bar. These stories exist for the chrome the shipped
 * header draws: the gutter the bar and the page body share, and the pill
 * fills.
 *
 * At the top level rather than in `domains/intelligence/` because the
 * composition reaches across chat, intelligence, and contacts, which is a
 * page-level job (see CONVENTIONS.md, "No cross-domain imports").
 *
 * The header takes its slot as a prop, so the frame below samples the slots
 * store and hands both the mobile bar and the title down the way `ChatLayout`
 * does.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { Route, Routes } from "react-router";

import { forceMobile } from "@/components/force-mobile-story-decorator";
import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { ChatLayoutHeader } from "@/domains/chat/chat-layout-header";
import {
  ContactsListWithSearch,
  FIXTURE_CONTACTS,
  FIXTURE_GUARDIAN,
} from "@/domains/contacts/components/contacts-list-fixtures";
import { IntelligenceLayout } from "@/domains/intelligence/intelligence-layout";
import {
  OutletStub,
  phoneGlobals,
  withDetailIsScreen,
  withRegisteredImport,
  withRegisteredPlus,
} from "@/domains/intelligence/intelligence-layout-story-fixtures";
import { useIsMobile } from "@/hooks/use-is-mobile";

interface MobileSectionScreenProps {
  /** The child route the section's page mounts at, under the layout. */
  path: string;
  /** What that child route renders into the layout's outlet. */
  outlet: ReactNode;
}

/**
 * The phone screen: the real header over the real layout, both fed from the
 * slot store the routes publish into.
 */
function MobileSectionScreen({ path, outlet }: MobileSectionScreenProps) {
  const isMobile = useIsMobile();
  const mobileTopBar = useChatLayoutSlotsStore.use.mobileTopBar();
  const topBarCenter = useChatLayoutSlotsStore.use.topBarCenter();

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-[var(--surface-overlay)]">
      <ChatLayoutHeader
        isMobile={isMobile}
        drawerOpen={false}
        collapsed
        toggleSidebar={() => {}}
        mobileTopBar={mobileTopBar}
        topBarCenter={topBarCenter}
      />
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Routes>
          <Route element={<IntelligenceLayout />}>
            <Route path={path} element={outlet} />
          </Route>
        </Routes>
      </main>
    </div>
  );
}

const meta: Meta<typeof MobileSectionScreen> = {
  title: "Intelligence/MobileScreens",
  component: MobileSectionScreen,
  // Opted out of the global `autodocs` tag for the reason the layout's own
  // stories give: the mobile top bar is a module-singleton slot, so on a docs
  // page that mounts every story the last screen to register would supply the
  // bar shown above all of them.
  tags: ["!autodocs"],
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
  },
  globals: phoneGlobals,
  decorators: [forceMobile],
};

export default meta;

type Story = StoryObj<typeof MobileSectionScreen>;

/**
 * The Contacts list as the phone page: the section owns the whole bar (back,
 * title, add), and the list below is the screen itself, so its search field
 * comes first and its rows carry no trailing icon.
 */
export const MobileContactsScreen: Story = {
  parameters: { router: { initialEntries: ["/assistant/contacts"] } },
  decorators: [withRegisteredPlus],
  args: {
    path: "/assistant/contacts",
    outlet: (
      <ContactsListWithSearch
        loading={false}
        guardian={FIXTURE_GUARDIAN}
        regularContacts={FIXTURE_CONTACTS}
        selectedContactId={null}
        onSelect={() => {}}
        onAddContact={() => {}}
        search=""
        surface="screen"
      />
    ),
  },
};

/**
 * One level deeper, where the detail is a pushed screen: Back aims at the
 * Contacts list rather than the assistant overview, and the add action is
 * gone. `ContactDetailView` takes the page's whole mutation surface, so the
 * body is a stand-in; the bar is what this story is for.
 */
export const MobileContactDetailScreen: Story = {
  parameters: { router: { initialEntries: ["/assistant/contacts/c-1"] } },
  decorators: [withDetailIsScreen],
  args: {
    path: "/assistant/contacts/:contactId",
    outlet: <OutletStub label="contact detail (outlet content)" />,
  },
};

/** Library, the other section with a registered action, an import pill. */
export const MobileLibraryScreen: Story = {
  parameters: { router: { initialEntries: ["/assistant/library"] } },
  decorators: [withRegisteredImport],
  args: {
    path: "/assistant/library",
    outlet: <OutletStub label="library grid (outlet content)" />,
  },
};

/**
 * Schedules registers no action, so the bar is back and title over an empty
 * trailing slot. This is what a section without an action looks like.
 */
export const MobileSchedulesScreen: Story = {
  parameters: { router: { initialEntries: ["/assistant/schedules"] } },
  args: {
    path: "/assistant/schedules",
    outlet: <OutletStub label="schedules list (outlet content)" />,
  },
};

/** My Superpowers, the section the skills and plugins routes share. */
export const MobileSuperpowersScreen: Story = {
  parameters: { router: { initialEntries: ["/assistant/superpowers"] } },
  args: {
    path: "/assistant/superpowers",
    outlet: <OutletStub label="superpowers list (outlet content)" />,
  },
};

/** Memory, hidden from the native overview but reachable on mobile web. */
export const MobileMemoryScreen: Story = {
  parameters: { router: { initialEntries: ["/assistant/memory"] } },
  args: {
    path: "/assistant/memory",
    outlet: <OutletStub label="concept graph (outlet content)" />,
  },
};

/** Workspace, the other section the native overview hides. */
export const MobileWorkspaceScreen: Story = {
  parameters: { router: { initialEntries: ["/assistant/workspace"] } },
  args: {
    path: "/assistant/workspace",
    outlet: <OutletStub label="workspace browser (outlet content)" />,
  },
};

/** Channels, whose detail stays a drawer beside the list rather than a push. */
export const MobileChannelsScreen: Story = {
  parameters: { router: { initialEntries: ["/assistant/channels"] } },
  args: {
    path: "/assistant/channels",
    outlet: <OutletStub label="channels list (outlet content)" />,
  },
};

/**
 * The personality stage. It is no section and takes no page shell, but it is
 * one drill-down below the overview, so the header carries its Back under the
 * label the overview card sent the user in by, and the stage itself paints
 * none.
 */
export const MobilePersonalityScreen: Story = {
  parameters: { router: { initialEntries: ["/assistant/personality"] } },
  args: {
    path: "/assistant/personality",
    outlet: <OutletStub label="personality stage (outlet content)" />,
  },
};
