/**
 * The Assistant Inbox flow, one story per state the sidebar entry can open
 * onto, each mounted in the desktop chat shell beside the real sidebar so the
 * new "Assistant Inbox" entry is seen where it will live: directly above
 * Preferences at the foot of the rail.
 *
 * 0. The upgrade itself: the provisioning takeover mid-rollout, its status
 *    copy and the metrics of the change with the character stream flowing
 *    around them.
 * 0b. An upgrade that has just landed: the same takeover finishes its
 *    celebration and hands off to the setup card, which is where the wizard
 *    now goes instead of its own domain step.
 * 1. On a plan without managed email, the inbox is an upgrade card that still
 *    carries the address builder, prefilled with the handle already set.
 * 2. On an entitled plan with no address yet, it is the email onboarding card,
 *    drawn inline instead of over the billing page.
 * 3. With an address, it is the mailbox: masthead, Inbox and Sent, a list
 *    beside a reading pane.
 *
 * Nothing here talks to a platform. The mail and avatar are fixtures,
 * and the handlers log to the Actions panel.
 */
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { fn } from "storybook/test";

import { AssistantSideMenu } from "@/domains/chat/components/assistant-side-menu";
import { PreferencesMenu } from "@/domains/chat/components/preferences-menu";
import { useSidebarLayoutStore } from "@/domains/chat/sidebar-layout-store";
import { saveViewMode } from "@/domains/chat/utils/sidebar-view-mode";
import { ProvisioningState } from "@/domains/settings/billing/pro-onboarding/provisioning-state";
import {
  TAKEOVER_CONSTANT_PROPS,
  TAKEOVER_SCENARIOS,
  TakeoverStage,
} from "@/domains/settings/billing/pro-onboarding/takeover-story-support";
import { appsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { avatarQueryKey } from "@/hooks/use-assistant-avatar";
import { withQueryCache } from "@/lib/story-query-cache";
import { useAuthStore } from "@/stores/auth-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { Conversation } from "@/types/conversation-types";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { preloadBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

import { AssistantInboxPage } from "./components/assistant-inbox-page";
import { AssistantInboxSetupCard } from "./components/assistant-inbox-setup-card";
import { AssistantInboxSetupSuccess } from "./components/assistant-inbox-setup-success";
import { AssistantInboxUpgradeState } from "./components/assistant-inbox-upgrade-state";
import {
  MOCK_ADDRESS,
  MOCK_ASSISTANT_HANDLE,
  MOCK_ASSISTANT_NAME,
  MOCK_INBOX,
  MOCK_NOW,
  MOCK_ROOT_DOMAIN,
  MOCK_SENT,
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
          footerAction={<PreferencesMenu assistantId={ASSISTANT_ID} />}
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
 * The upgrade in progress, as the wizard draws it: the provisioning takeover
 * over the app, mid-rollout on a base-to-Super upgrade with the machine
 * landed and the storage still moving. The phase playground under
 * Settings/Billing/ProOnboarding drives every other state of this screen.
 */
export const Upgrading: Story = {
  name: "0 · Upgrading",
  render: () => {
    const scenario = TAKEOVER_SCENARIOS.baseToSuper;
    return (
      <div className="fixed inset-0 z-50">
        <TakeoverStage>
          <ProvisioningState
            {...TAKEOVER_CONSTANT_PROPS}
            state="WAITING"
            direction={scenario.direction}
            intent={scenario.intent}
            creditsChange={scenario.creditsChange}
            targets={scenario.targets}
            fromSnapshot={scenario.fromSnapshot}
            landed={{ machine: true, storage: false }}
            softWaiting={false}
            escapeAvailable={false}
            celebrating={false}
          />
        </TakeoverStage>
      </div>
    );
  },
};

/** How long the takeover's "All done!" holds before the hand-off. */
const STORY_CELEBRATION_MS = 2500;

/**
 * The end of a plan upgrade, as the billing wizard now plays it: the
 * full-bleed takeover celebrates the landed resize over the app, then hands
 * off to the inbox's setup card in place of the wizard's old domain step. The
 * takeover's plan-catalog read resolves from the stage's cache; the card
 * beneath is the same "2 · Set up email".
 */
function UpgradeHandoff() {
  const [landed, setLanded] = useState(false);
  const scenario = TAKEOVER_SCENARIOS.baseToSuper;
  return (
    <>
      <AssistantInboxSetupCard
        assistantId={ASSISTANT_ID}
        handle={MOCK_ASSISTANT_HANDLE}
        rootDomain={MOCK_ROOT_DOMAIN}
        onConfirm={fn().mockName("onConfirm")}
      />
      {!landed ? (
        /* Over the shell, the way the modal's takeover covers the billing
           page. `fixed` here, not in the stage, so the stage stays reusable
           in flow. */
        <div className="fixed inset-0 z-50">
          <TakeoverStage>
            <ProvisioningState
              {...TAKEOVER_CONSTANT_PROPS}
              state="DONE"
              direction={scenario.direction}
              intent={scenario.intent}
              creditsChange={scenario.creditsChange}
              targets={scenario.targets}
              fromSnapshot={scenario.fromSnapshot}
              landed={{ machine: true, storage: true }}
              softWaiting={false}
              escapeAvailable={false}
              dwellMs={STORY_CELEBRATION_MS}
              onCelebrationEnd={() => setLanded(true)}
            />
          </TakeoverStage>
        </div>
      ) : null}
    </>
  );
}

/**
 * An upgrade lands. The takeover's celebration runs its dwell, then the
 * setup card is what is left on screen. Remount the story to replay it.
 */
export const ArrivingFromUpgrade: Story = {
  name: "0b · Arriving from an upgrade",
  render: () => <UpgradeHandoff />,
};

/**
 * No managed-email entitlement. The upgrade card, with the address builder
 * prefilled from the handle the user already chose.
 */
export const UpgradeRequired: Story = {
  name: "1 · Upgrade required",
  /* The rail entry carries its dismiss only here: with no inbox to open,
     the entry is a pitch, and a pitch can be declined. */
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
      onBack={fn().mockName("onBack")}
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
      onBack={fn().mockName("onBack")}
    />
  ),
};

/**
 * The registration refused what was typed. The platform's own message sits
 * under the fields, beside the thing to fix, and the action stays available
 * so a corrected draft can be sent again.
 */
export const SetUpEmailRefused: Story = {
  name: "2c · Set up email, refused",
  render: () => (
    <AssistantInboxSetupCard
      assistantId={ASSISTANT_ID}
      handle={MOCK_ASSISTANT_HANDLE}
      rootDomain={MOCK_ROOT_DOMAIN}
      error="That address is already taken on this domain."
      onConfirm={fn().mockName("onConfirm")}
      onBack={fn().mockName("onBack")}
    />
  ),
};

/** Every received message but the two newest has been opened here. */
const MOCK_READ_IDS: ReadonlySet<string> = new Set(
  MOCK_INBOX.slice(2).map((email) => email.id),
);

/** The moment after the address is made: the line types in, then the way in. */
export const SetUpEmailDone: Story = {
  name: "2d · Address created",
  render: () => (
    <AssistantInboxSetupSuccess
      assistantId={ASSISTANT_ID}
      assistantName={MOCK_ASSISTANT_NAME}
      address={MOCK_ADDRESS}
      onContinue={fn().mockName("onContinue")}
      onBack={fn().mockName("onBack")}
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
      now={MOCK_NOW}
      onAskToReply={fn().mockName("onAskToReply")}
      onStartChat={fn().mockName("onStartChat")}
      onDeleteEmails={fn().mockName("onDeleteEmails")}
      onOpenSettings={fn().mockName("onOpenSettings")}
      readIds={MOCK_READ_IDS}
      onRead={fn().mockName("onRead")}
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
      now={MOCK_NOW}
      initialSelectedId="in-2"
      onAskToReply={fn().mockName("onAskToReply")}
      readIds={MOCK_READ_IDS}
      onRead={fn().mockName("onRead")}
    />
  ),
};

/**
 * Two messages checked in Received and one in Sent: the checkbox holds the
 * disc's place on every row, and the bar over the cards counts the selection
 * by folder. Hover an unchecked row to see the box take the disc's place.
 */
export const InboxSelecting: Story = {
  name: "3f · Selecting messages",
  render: () => (
    <AssistantInboxPage
      assistantId={ASSISTANT_ID}
      assistantName={MOCK_ASSISTANT_NAME}
      address={MOCK_ADDRESS}
      inbox={MOCK_INBOX}
      sent={MOCK_SENT}
      now={MOCK_NOW}
      initialCheckedIds={[
        MOCK_INBOX[0]!.id,
        MOCK_INBOX[1]!.id,
        MOCK_SENT[0]!.id,
      ]}
      onAskToReply={fn().mockName("onAskToReply")}
      onStartChat={fn().mockName("onStartChat")}
      onDeleteEmails={fn().mockName("onDeleteEmails")}
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
      now={MOCK_NOW}
    />
  ),
};
