/**
 * Full-header visual matrix, built to protect the conversation header's right
 * cluster now that `ConversationActivityPill` sits in it beside Assets.
 *
 * The header is assembled here the way `ChatLayout` + `routes.tsx` assemble it —
 * a long conversation title in the centre slot, and Assets / Activity /
 * Notifications in `topBarRightSlot` — because the thing worth protecting is the
 * *composition*: whether the title still shrinks, and whether the cluster stays
 * readable once Activity joins it.
 *
 * Notifications is a stand-in, not the real `NotificationsBell`: that component
 * belongs to the home domain and `routes.tsx` injects it into the chat layout at
 * runtime, so importing it here trips the cross-domain import rule. The stand-in
 * is the same ghost icon-only `Button` with the same glyph, which is all this
 * story needs it to be — it exists to occupy the cluster, not to be exercised.
 *
 * Only four states are covered. The per-status card matrix for subagents and ACP
 * runs belongs to their component tests, not to a header story.
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
import { ChatLayoutHeader } from "@/domains/chat/chat-layout-header";
import { ConversationActivityPill } from "@/domains/chat/components/conversation-activity-pill";
import { ConversationAssetsPill } from "@/domains/chat/components/conversation-assets-pill";
import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { MOBILE_MEDIA_QUERY } from "@/hooks/use-is-mobile";

const ASSISTANT_ID = "asst-story";
const CONVERSATION_ID = "conv-story";
const T0 = 1_700_000_000_000;

const LONG_TITLE =
  "Investigating why the nightly ingestion job silently drops Slack threads " +
  "after a gateway restart";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One running ACP run and one finished subagent — the mixed case. */
function seedMixedActivity() {
  useAcpRunStore.getState().spawnRun({
    acpSessionId: "acp-live",
    agent: "claude",
    parentConversationId: CONVERSATION_ID,
    startedAt: T0,
  });
  useAcpRunStore.getState().receiveEvent({
    acpSessionId: "acp-live",
    event: {
      seq: 1,
      updateType: "tool_call",
      toolCallId: "tc-1",
      toolTitle: "Reading gateway restart logs",
      toolStatus: "in_progress",
    },
  });

  useSubagentStore.getState().spawnSubagent({
    subagentId: "sa-done",
    label: "slack-thread-audit",
    objective: "Audit dropped Slack threads",
    status: "completed",
    conversationId: "sa-done-child",
    parentConversationId: CONVERSATION_ID,
    timestamp: T0 + 1_000,
  });
  // Load a timeline so the finished card settles into its terminal state
  // instead of the detail-fetch placeholder.
  useSubagentStore.getState().loadDetail({
    subagentId: "sa-done",
    events: [
      {
        id: "sa-done-e1",
        type: "text",
        content: "Found 12 dropped threads across 3 channels",
        timestamp: T0 + 1_500,
      },
    ],
  });
}

function resetActivity() {
  useAcpRunStore.getState().reset();
  useSubagentStore.getState().reset();
}

/**
 * Placeholder for the injected `NotificationsBell` — same ghost icon-only
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
 * Seeds the assets query cache (so the Assets pill has something to show
 * without a daemon) and, optionally, the activity stores. Stores are global
 * singletons, so the teardown matters: without it a story leaks its fixtures
 * into whichever story renders next.
 */
function Harness({
  withActivity,
  isMobile,
}: {
  withActivity: boolean;
  isMobile: boolean;
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
    if (withActivity) {
      seedMixedActivity();
    }
    return true;
  });
  void seeded;

  useEffect(() => resetActivity, []);

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
          <ConversationAssetsPill
            assistantId={ASSISTANT_ID}
            conversationId={CONVERSATION_ID}
          />
          <ConversationActivityPill conversationId={CONVERSATION_ID} />
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
  // this component's render — i.e. before any child samples the query. An
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

/** Click the Activity trigger so the story renders with its panel open. */
const openActivityPanel = async ({
  canvasElement,
}: {
  canvasElement: HTMLElement;
}) => {
  const trigger = canvasElement.querySelector<HTMLElement>(
    '[data-testid="conversation-activity-pill"]',
  );
  trigger?.click();
};

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
 * The header with no agent activity at all: a long title, Assets, Notifications
 * — and no Activity control, because the conversation has nothing to reopen.
 * This is the baseline the control must not disturb.
 */
export const DesktopBaseline: Story = {
  args: { withActivity: false, isMobile: false },
};

/**
 * One running ACP run and one finished subagent. Closed, the trigger shows the
 * live treatment and counts only the running work — the finished session is
 * reachable but doesn't inflate the count or make the header look busy.
 */
export const DesktopMixedClosed: Story = {
  args: { withActivity: true, isMobile: false },
};

/**
 * The same data with the popover open: the running run carries a Stop control,
 * the finished subagent doesn't, and either row opens the existing process
 * detail viewer.
 */
export const DesktopMixedOpen: Story = {
  args: { withActivity: true, isMobile: false },
  play: openActivityPanel,
};

/**
 * The mobile composition: the cluster collapses to icon-only triggers and
 * Activity opens the bottom sheet rather than a popover.
 */
export const MobileMixedOpen: Story = {
  args: { withActivity: true, isMobile: true },
  decorators: [
    (Story) => (
      <ForceMobile>
        <Story />
      </ForceMobile>
    ),
  ],
  play: openActivityPanel,
};
