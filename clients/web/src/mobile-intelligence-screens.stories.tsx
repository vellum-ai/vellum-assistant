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
 * The header takes its slot as a prop, so the shared frame samples the slots
 * store and hands both the mobile bar and the title down the way `ChatLayout`
 * does.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { forceMobile } from "@/components/force-mobile-story-decorator";
import {
  ContactsListWithSearch,
  FIXTURE_CONTACTS,
  FIXTURE_GUARDIAN,
} from "@/domains/contacts/components/contacts-list-fixtures";
import {
  OutletStub,
  phoneGlobals,
  withDetailIsScreen,
  withRegisteredImport,
  withRegisteredPlus,
} from "@/domains/intelligence/intelligence-layout-story-fixtures";
import { WorkspaceBrowser } from "@/domains/workspace/components/workspace-browser";
import {
  seedWorkspaceStory,
  workspaceStoryBinaryFetch,
  WORKSPACE_STORY_ASSISTANT_ID,
} from "@/domains/workspace/workspace-story-fixtures";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import { IntelligenceSectionStoryFrame } from "@/intelligence-section-story-frame";
import { withQueryCache } from "@/lib/story-query-cache";
import { fixtureNotFound, stubClientFetch } from "@/lib/stub-client-fetch";

const meta: Meta<typeof IntelligenceSectionStoryFrame> = {
  title: "Intelligence/MobileScreens",
  component: IntelligenceSectionStoryFrame,
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

type Story = StoryObj<typeof IntelligenceSectionStoryFrame>;

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
  decorators: [withQueryCache(seedWorkspaceStory)],
  beforeEach: () => stubClientFetch(daemonClient, workspaceStoryBinaryFetch),
  args: {
    path: "/assistant/workspace",
    outlet: <WorkspaceBrowser assistantId={WORKSPACE_STORY_ASSISTANT_ID} />,
  },
};

export const MobileWorkspaceFile: Story = {
  ...MobileWorkspaceScreen,
  parameters: {
    router: { initialEntries: ["/assistant/workspace?file=README.md"] },
  },
};

export const MobileWorkspaceLongFilename: Story = {
  ...MobileWorkspaceScreen,
  parameters: {
    router: {
      initialEntries: [
        "/assistant/workspace?file=notes/projects/example/project-plan-with-a-long-descriptive-filename.md",
      ],
    },
  },
};

export const MobileWorkspaceOneParent: Story = {
  ...MobileWorkspaceScreen,
  parameters: {
    router: {
      initialEntries: ["/assistant/workspace?file=tools/workspace-ask.sh"],
    },
  },
};

export const MobileWorkspacePicker: Story = {
  ...MobileWorkspaceFile,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: /Switch file: README.md/ }),
    );
    const sheet = within(
      await within(canvasElement.ownerDocument.body).findByRole("dialog"),
    );
    await userEvent.click(
      sheet.getByRole("button", { name: "Show hidden files" }),
    );
    await expect(sheet.getByText(".notes.md")).toBeVisible();
  },
};

/** Select a real row while its content request remains in flight. */
export const MobileWorkspacePending: Story = {
  ...MobileWorkspaceScreen,
  decorators: [
    withQueryCache((client) =>
      seedWorkspaceStory(client, { omitFileContents: ["README.md"] }),
    ),
  ],
  beforeEach: () =>
    stubClientFetch(daemonClient, (request) => {
      const url = new URL(request.url);
      if (
        url.pathname.endsWith("/workspace/file") &&
        url.searchParams.get("path") === "README.md"
      ) {
        return new Promise<Response>(() => {});
      }
      return fixtureNotFound();
    }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Choose a file" }),
    );
    const sheet = within(
      await within(canvasElement.ownerDocument.body).findByRole("dialog"),
    );
    await userEvent.click(sheet.getByRole("button", { name: /README.md/ }));
    await expect(
      await canvas.findByRole("button", { name: /Switch file: README.md/ }),
    ).toBeVisible();
  },
};

export const MobileWorkspaceMissingFile: Story = {
  ...MobileWorkspaceFile,
  decorators: [
    withQueryCache((client) =>
      seedWorkspaceStory(client, { omitFileContents: ["README.md"] }),
    ),
  ],
  beforeEach: () => stubClientFetch(daemonClient, fixtureNotFound),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("File not found")).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: /Switch file: README.md/ }),
    ).toBeEnabled();
  },
};

export const MobileWorkspaceSource: Story = {
  ...MobileWorkspaceScreen,
  parameters: {
    router: { initialEntries: ["/assistant/workspace?file=config.json"] },
  },
};

export const MobileWorkspaceMarkdownSource: Story = {
  ...MobileWorkspaceFile,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("radio", { name: "Source" }));
    await expect(canvas.getByRole("radio", { name: "Source" })).toBeChecked();
  },
};

export const MobileWorkspaceImage: Story = {
  ...MobileWorkspaceScreen,
  parameters: {
    router: { initialEntries: ["/assistant/workspace?file=assets/sample.svg"] },
  },
};

export const MobileWorkspaceBinary: Story = {
  ...MobileWorkspaceScreen,
  parameters: {
    router: { initialEntries: ["/assistant/workspace?file=exports/archive.zip"] },
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
