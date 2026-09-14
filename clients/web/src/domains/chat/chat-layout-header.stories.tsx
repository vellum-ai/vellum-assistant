/**
 * Full-header visual matrix, protecting the conversation header's right
 * cluster.
 *
 * The header is assembled here the way `ChatLayout` + `routes.tsx` assemble it:
 * a long conversation title in the centre slot, and Assets / Notifications in
 * `topBarRightSlot`. The thing worth protecting is the *composition*: whether
 * the title still shrinks, and whether the cluster stays readable beside it.
 *
 * Notifications is a stand-in, not the real `NotificationsBell`: that component
 * belongs to the home domain and `routes.tsx` injects it into the chat layout at
 * runtime, so importing it here trips the cross-domain import rule. The stand-in
 * is the same ghost icon-only `Button` with the same glyph, which is all this
 * story needs it to be. It exists to occupy the cluster, not to be exercised.
 *
 * The Assets pill's conversation is seeded by the shared Chat Info decorator,
 * on ids of this file's own so a panel opened here can only be this header's.
 *
 * The states covered are the composition's, not a per-component matrix: the
 * desktop and mobile baselines, a channel-bound header, the desktop header
 * with the Chat Info panel open, where the Assets trigger reads as selected,
 * and the header of a chat whose assets could not be loaded. The mobile
 * trigger carries the same `active` fill open or closed, so there is no second
 * open state to show.
 */

import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "@vellumai/design-library";

import { ChannelSourceLinkPill } from "@/domains/chat/components/channel-source-link-pill";
import { ChatLayoutHeader } from "@/domains/chat/chat-layout-header";
import { makePreviewableImages } from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import {
  failChatInfoDocuments,
  inChatInfoConversation,
} from "@/domains/chat/components/chat-info-story-fixtures";
import { ConversationAssetsPill } from "@/domains/chat/components/conversation-assets-pill";
import { MOBILE_MEDIA_QUERY } from "@/hooks/use-is-mobile";
import { useViewerStore } from "@/stores/viewer-store";

/** This header's own conversation, distinct from the panel stories' fixture ids. */
const ASSISTANT_ID = "asst-story";
const CONVERSATION_ID = "conv-story";

const LONG_TITLE =
  "Investigating why the nightly ingestion job silently drops Slack threads " +
  "after a gateway restart";

/**
 * Placeholder for the injected `NotificationsBell`: the same ghost icon-only
 * `Button` and glyph, so the cluster's spacing and shrink behavior match the
 * real header. See the file header for why the real component isn't imported.
 */
function NotificationsStandIn() {
  return (
    <Button
      variant="ghost"
      iconOnlyGlyphClassName="[&_svg]:size-4.5 touch-mobile:[&_svg]:size-4.5"
      iconOnly={<Bell />}
      aria-label="Notifications"
    />
  );
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function Harness({
  isMobile,
  channelBound = false,
}: {
  isMobile: boolean;
  /** Renders the "Open in Slack" source-link pill leading the cluster, the
   *  way `useChatHeaderRegistration` composes it for channel-bound chats. */
  channelBound?: boolean;
}) {
  return (
    <ChatLayoutHeader
      isMobile={isMobile}
      drawerOpen={false}
      collapsed={false}
      toggleSidebar={() => {}}
      topBarCenter={
        <span className="min-w-0 truncate text-sm font-medium text-[var(--content-default)]">
          {LONG_TITLE}
        </span>
      }
      topBarRightSlot={
        <>
          {channelBound ? (
            <ChannelSourceLinkPill
              href="https://example.slack.com/archives/C0123456789/p1720000000000000"
              channelId="slack"
            />
          ) : null}
          <ConversationAssetsPill
            assistantId={ASSISTANT_ID}
            conversationId={CONVERSATION_ID}
          />
          <NotificationsStandIn />
        </>
      }
    />
  );
}

/** Swap `window.matchMedia`; `configurable` so the teardown can put it back. */
function setMatchMedia(impl: typeof window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    value: impl,
    configurable: true,
    writable: true,
  });
}

/**
 * Forces the mobile branch of `useIsMobile` for the duration of the story.
 *
 * Overriding the media query beats resizing the preview iframe: the story then
 * shows the mobile composition regardless of the viewport the docs page happens
 * to render at.
 */
const forceMobile: Decorator = function ForceMobile(Story) {
  // Installed from a `useState` initializer, which runs exactly once and during
  // this decorator's render, i.e. before the story samples the query. An
  // identity check against the saved original would not work here: `bind`
  // returns a new function object, so it never compares equal to the global.
  const [original] = useState(() => {
    const saved = window.matchMedia.bind(window);
    setMatchMedia(((query: string) => {
      const result = saved(query);
      if (query !== MOBILE_MEDIA_QUERY) {
        return result;
      }
      return {
        ...result,
        media: query,
        matches: true,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      } as MediaQueryList;
    }) as typeof window.matchMedia);
    return saved;
  });
  useEffect(() => {
    return () => setMatchMedia(original);
  }, [original]);
  return <Story />;
};

/**
 * Opens the Chat Info panel for this header's conversation, so the Assets
 * trigger renders the selected state it holds while the panel is on screen.
 */
const withChatInfoOpen: Decorator = function WithChatInfoOpen(Story) {
  // A `useState` initializer runs during this decorator's own render, i.e.
  // before the trigger below it first samples the store.
  useState(() => {
    useViewerStore.getState().openChatInfo({
      assistantId: ASSISTANT_ID,
      conversationId: CONVERSATION_ID,
    });
  });
  useEffect(() => {
    return () => useViewerStore.getState().closeChatInfo();
  }, []);
  return <Story />;
};

const meta: Meta<typeof Harness> = {
  title: "Chat/ChatLayoutHeader",
  component: Harness,
  // Opted out of the global `autodocs` tag. Every story seeds the same
  // module-singleton chat-session store, so on a docs page that mounts them all
  // the last transcript seeded would show up in every other story.
  tags: ["!autodocs"],
  parameters: {
    layout: "fullscreen",
    chatInfo: {
      assistantId: ASSISTANT_ID,
      conversationId: CONVERSATION_ID,
      appCount: 1,
      documentCount: 0,
      attachments: [],
    },
  },
  decorators: [inChatInfoConversation],
};

export default meta;
type Story = StoryObj<typeof Harness>;

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

/**
 * A long title beside Assets and Notifications: the case that decides whether
 * the centre slot still truncates instead of shoving the cluster off the edge.
 */
export const DesktopBaseline: Story = {
  args: { isMobile: false },
};

/**
 * A channel-bound conversation: the "Open in Slack" source-link pill leads the
 * cluster, taking width from the same row the title is competing for.
 */
export const DesktopChannelBound: Story = {
  args: { isMobile: false, channelBound: true },
};

/**
 * The narrow header, where the title has the least room to give.
 */
export const MobileBaseline: Story = {
  args: { isMobile: true },
  decorators: [forceMobile],
};

/**
 * The Chat Info panel is open on this conversation, so the Assets glyph carries
 * the `active` fill that marks it as the selected view. Two transcript images
 * join the app, so the trigger counts both of the sources it reads.
 */
export const AssetsPanelOpen: Story = {
  args: { isMobile: false },
  parameters: { chatInfo: { attachments: makePreviewableImages(2) } },
  decorators: [withChatInfoOpen],
};

/**
 * A chat whose documents source is down with nothing cached. The trigger stays
 * in the cluster with nothing counted, since the panel is where the user finds
 * out why.
 */
export const TriggerUnavailable: Story = {
  args: { isMobile: false },
  parameters: {
    chatInfo: {
      appCount: 0,
      documentCount: 0,
      attachments: [],
      afterSeed: failChatInfoDocuments,
    },
  },
};
