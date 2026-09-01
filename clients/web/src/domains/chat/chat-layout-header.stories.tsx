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
 * Three states are covered: the composition is what this file protects, not a
 * per-component matrix.
 */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "@vellumai/design-library";

import {
  appsGetQueryKey,
  documentsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { ChannelSourceLinkPill } from "@/domains/chat/components/channel-source-link-pill";
import { ChatLayoutHeader } from "@/domains/chat/chat-layout-header";
import { ConversationAssetsPill } from "@/domains/chat/components/conversation-assets-pill";
import { MOBILE_MEDIA_QUERY } from "@/hooks/use-is-mobile";

const ASSISTANT_ID = "asst-story";
const CONVERSATION_ID = "conv-story";
const T0 = 1_700_000_000_000;

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

/**
 * Seeds the assets query cache, so the Assets pill has something to show
 * without a daemon.
 */
function Harness({
  isMobile,
  channelBound = false,
}: {
  isMobile: boolean;
  /** Renders the "Open in Slack" source-link pill leading the cluster, the
   *  way `useChatHeaderRegistration` composes it for channel-bound chats. */
  channelBound?: boolean;
}) {
  const queryClient = useQueryClient();
  const [seeded] = useState(() => {
    queryClient.setQueryData(
      appsGetQueryKey({
        path: { assistant_id: ASSISTANT_ID },
        query: { conversationId: CONVERSATION_ID },
      }),
      {
        apps: [
          {
            id: "app-1",
            name: "Ingestion dashboard",
            createdAt: T0,
            updatedAt: T0,
            version: "1",
            contentId: "c1",
            origin: "workspace",
          },
        ],
      },
    );
    queryClient.setQueryData(
      documentsGetQueryKey({
        path: { assistant_id: ASSISTANT_ID },
        query: { conversationId: CONVERSATION_ID },
      }),
      { documents: [] },
    );
    return true;
  });
  void seeded;


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
function ForceMobile({ children }: { children: React.ReactNode }) {
  // Installed from a `useState` initializer, which runs exactly once and during
  // this component's render, i.e. before any child samples the query. An
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
  return <>{children}</>;
}

const meta: Meta<typeof Harness> = {
  title: "Chat/ChatLayoutHeader",
  component: Harness,
  parameters: { layout: "fullscreen" },
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
  decorators: [
    (Story) => (
      <ForceMobile>
        <Story />
      </ForceMobile>
    ),
  ],
};
