/**
 * The Assistant Inbox flow, one story per state the sidebar entry can open
 * onto, each mounted in the desktop chat shell beside the real sidebar so the
 * new "Assistant Inbox" entry is seen where it will live: directly above
 * Preferences at the foot of the rail.
 *
 * 1. On a plan without managed email, the inbox is an upgrade card that still
 *    carries the address builder, prefilled with the handle already set.
 * 2. On an entitled plan with no address yet, it is the email onboarding card,
 *    drawn inline instead of over the billing page.
 * 3. With an address, it is the mailbox: masthead, Inbox and Sent, a list
 *    beside a reading pane.
 *
 * Nothing here talks to a platform. The mail, usage, and avatar are fixtures,
 * and the handlers log to the Actions panel.
 */
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { AssistantSideMenu } from "@/domains/chat/components/assistant-side-menu";
import { PreferencesMenu } from "@/domains/chat/components/preferences-menu";
import { useSidebarLayoutStore } from "@/domains/chat/sidebar-layout-store";
import { saveViewMode } from "@/domains/chat/utils/sidebar-view-mode";
import { appsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { avatarQueryKey } from "@/hooks/use-assistant-avatar";
import { withQueryCache } from "@/lib/story-query-cache";
import { useAuthStore } from "@/stores/auth-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { Conversation } from "@/types/conversation-types";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { preloadBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

import { AssistantInboxNavItem } from "./components/assistant-inbox-nav-item";
import { AssistantInboxPage } from "./components/assistant-inbox-page";
import { AssistantInboxSetupCard } from "./components/assistant-inbox-setup-card";
import { AssistantInboxUpgradeState } from "./components/assistant-inbox-upgrade-state";
import {
  MOCK_ADDRESS,
  MOCK_ASSISTANT_HANDLE,
  MOCK_ASSISTANT_NAME,
  MOCK_INBOX,
  MOCK_NOW,
  MOCK_ROOT_DOMAIN,
  MOCK_SENT,
  MOCK_USAGE,
} from "./mock-emails";

// The cards hang creatures off their edges from a dynamic import.
preloadBundledAvatarComponents();

const ASSISTANT_ID = "asst-inbox-story";

const CONVERSATIONS: Conversation[] = [
  {
    conversationId: "c1",
    title: "Confirm the dentist for Thursday",
    lastMessageAt: 60,
  },
  {
    conversationId: "c2",
    title: "Northwind contract redlines",
    lastMessageAt: 40,
  },
  { conversationId: "c3", title: "Dinner with Sam", lastMessageAt: 20 },
];

/**
 * One cache for every story: the avatar the masthead and the identity row
 * both draw (seeded under both spellings of the key, since the hook appends a
 * manifest-support flag the story cannot predict) and the empty pinned-app
 * list the sidebar reads.
 */
const withInboxQueryCache = withQueryCache((client) => {
  for (const supportsManifest of [true, false]) {
    client.setQueryData([...avatarQueryKey(ASSISTANT_ID), supportsManifest], {
      components: BUNDLED_COMPONENTS,
      traits: { bodyShape: "blob", eyeStyle: "curious", color: "purple" },
      customImageUrl: null,
    });
  }
  client.setQueryData(
    appsGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
    { apps: [] },
  );
  client.setQueryData(["assistant-capability", "appPins", ASSISTANT_ID], true);
});

/**
 * The stores the sidebar and the avatar hook read from. The sidebar's view
 * mode is stored per assistant; the footer's Preferences entry renders only
 * for a signed-in session; the avatar hook keys on the active assistant.
 */
function seedStores(): void {
  saveViewMode(ASSISTANT_ID, "all");
  useSidebarLayoutStore.setState({ assistantId: null });
  useAuthStore.setState({ sessionStatus: "authenticated" });
  useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
}

interface InboxStoryArgs {
  /** Collapse the rail, to see the entry as a tile above Preferences. */
  collapsed: boolean;
}

/**
 * The desktop chat shell, class for class with `chat-layout`: the `gap-4 p-4`
 * row on the page background, the shrink-wrapped aside the rail sizes, and
 * the transparent main beside it that the inbox fills.
 */
const shellDecorator: Decorator<InboxStoryArgs> = function ChatShell(
  Story,
  context,
) {
  const { collapsed } = context.args;
  return (
    <div className="flex h-screen gap-4 bg-[var(--surface-base)] p-4">
      <aside className="w-fit shrink-0 overflow-hidden">
        <AssistantSideMenu
          assistantId={ASSISTANT_ID}
          assistantName={MOCK_ASSISTANT_NAME}
          collapsed={collapsed}
          variant="rail"
          width={280}
          onWidthChange={() => {}}
          conversations={CONVERSATIONS}
          conversationGroups={[]}
          onSelectConversation={() => {}}
          onOpenIntelligence={() => {}}
          onStartNewConversation={() => {}}
          footerAction={
            <div className="flex flex-col gap-2">
              <AssistantInboxNavItem
                assistantId={ASSISTANT_ID}
                collapsed={collapsed}
                onSelect={() => {}}
                onDismiss={
                  context.parameters.inboxDismissible
                    ? fn().mockName("onDismiss")
                    : undefined
                }
              />
              <PreferencesMenu assistantId={ASSISTANT_ID} />
            </div>
          }
        />
      </aside>
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Story />
      </main>
    </div>
  );
};

const meta: Meta<InboxStoryArgs> = {
  title: "AssistantInbox/Flow",
  // The shell is a full viewport, so one docs iframe cannot show these
  // stories beside each other.
  tags: ["!autodocs"],
  parameters: { layout: "fullscreen" },
  argTypes: {
    collapsed: {
      description: "Collapse the rail to see the entry as a tile.",
      control: "boolean",
    },
  },
  args: { collapsed: false },
  beforeEach: seedStores,
  decorators: [shellDecorator, withInboxQueryCache],
};

export default meta;
type Story = StoryObj<InboxStoryArgs>;

/**
 * No managed-email entitlement. The upgrade card, with the address builder
 * prefilled from the handle the user already chose.
 */
export const UpgradeRequired: Story = {
  name: "1 · Upgrade required",
  /* The rail entry carries its dismiss only here: with no inbox to open,
     the entry is a pitch, and a pitch can be declined. */
  parameters: { inboxDismissible: true },
  render: () => (
    <AssistantInboxUpgradeState
      assistantId={ASSISTANT_ID}
      assistantName={MOCK_ASSISTANT_NAME}
      handle={MOCK_ASSISTANT_HANDLE}
      rootDomain={MOCK_ROOT_DOMAIN}
      onEditHandle={fn().mockName("onEditHandle")}
      onUpgrade={fn().mockName("onUpgrade")}
      onSeePlans={fn().mockName("onSeePlans")}
    />
  ),
};

/** Entitled, no address yet. The email onboarding card, inline. */
export const SetUpEmail: Story = {
  name: "2 · Set up email",
  render: () => (
    <AssistantInboxSetupCard
      assistantId={ASSISTANT_ID}
      handle={MOCK_ASSISTANT_HANDLE}
      rootDomain={MOCK_ROOT_DOMAIN}
      onConfirm={fn().mockName("onConfirm")}
    />
  ),
};

/**
 * Entitled, no address, and no domain either: the handle is still open, so
 * it is a field with the permanence warning. The story's probe refuses the
 * handle `taken`, to show the inline refusal and the held action.
 */
export const SetUpEmailChooseHandle: Story = {
  name: "2b · Set up email, choosing a handle",
  render: () => (
    <AssistantInboxSetupCard
      assistantId={ASSISTANT_ID}
      handle="bright-vole-02a64h"
      rootDomain={MOCK_ROOT_DOMAIN}
      handleEditable
      checkHandle={async (handle) =>
        handle === "taken"
          ? { available: false, message: "That handle is already taken." }
          : { available: true }
      }
      onConfirm={fn().mockName("onConfirm")}
    />
  ),
};

/** Entitled with an address. The mailbox, seeded with received and sent mail. */
export const Inbox: Story = {
  name: "3 · Inbox",
  render: () => (
    <AssistantInboxPage
      assistantId={ASSISTANT_ID}
      assistantName={MOCK_ASSISTANT_NAME}
      address={MOCK_ADDRESS}
      inbox={MOCK_INBOX}
      sent={MOCK_SENT}
      usage={MOCK_USAGE}
      now={MOCK_NOW}
      onAskToReply={fn().mockName("onAskToReply")}
    />
  ),
};

/** A message open in the reading pane: the one with attachments. */
export const InboxReading: Story = {
  name: "3b · Reading a message",
  render: () => (
    <AssistantInboxPage
      assistantId={ASSISTANT_ID}
      assistantName={MOCK_ASSISTANT_NAME}
      address={MOCK_ADDRESS}
      inbox={MOCK_INBOX}
      sent={MOCK_SENT}
      usage={MOCK_USAGE}
      now={MOCK_NOW}
      initialSelectedId="in-2"
      onAskToReply={fn().mockName("onAskToReply")}
    />
  ),
};

/** The Sent folder, open on the assistant's weekly summary. */
export const SentFolder: Story = {
  name: "3c · Sent folder",
  render: () => (
    <AssistantInboxPage
      assistantId={ASSISTANT_ID}
      assistantName={MOCK_ASSISTANT_NAME}
      address={MOCK_ADDRESS}
      inbox={MOCK_INBOX}
      sent={MOCK_SENT}
      usage={MOCK_USAGE}
      now={MOCK_NOW}
      initialFolder="sent"
      initialSelectedId="out-3"
    />
  ),
};

/**
 * Rows as the platform lists them, with no preview, body, or attachments,
 * and a loader that takes a moment to answer: the shape production runs on.
 * Open a message to see the pane load the body in.
 */
export const InboxFetchedBodies: Story = {
  name: "3e · Bodies fetched on open",
  render: () => (
    <AssistantInboxPage
      assistantId={ASSISTANT_ID}
      assistantName={MOCK_ASSISTANT_NAME}
      address={MOCK_ADDRESS}
      inbox={MOCK_INBOX.map(
        ({ snippet: _snippet, body: _body, attachments: _a, ...row }) => row,
      )}
      sent={MOCK_SENT.map(
        ({ snippet: _snippet, body: _body, attachments: _a, ...row }) => row,
      )}
      usage={MOCK_USAGE}
      now={MOCK_NOW}
      loadDetail={async (email) => {
        await new Promise((resolve) => setTimeout(resolve, 900));
        const full = [...MOCK_INBOX, ...MOCK_SENT].find(
          (candidate) => candidate.id === email.id,
        );
        return {
          body: full?.body ?? "",
          attachments: full?.attachments ?? [],
        };
      }}
      onAskToReply={fn().mockName("onAskToReply")}
    />
  ),
};

/** The mailbox the moment the address exists and nothing has arrived. */
export const InboxEmpty: Story = {
  name: "3d · Inbox, empty",
  render: () => (
    <AssistantInboxPage
      assistantId={ASSISTANT_ID}
      assistantName={MOCK_ASSISTANT_NAME}
      address={MOCK_ADDRESS}
      inbox={[]}
      sent={[]}
      usage={{ sentToday: 0, receivedToday: 0, dailyLimit: 100 }}
      now={MOCK_NOW}
    />
  ),
};
