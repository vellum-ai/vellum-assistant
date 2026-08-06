import { useCallback, useEffect, useMemo } from "react";
import { useLocation, useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import type { ActivityLocationState } from "@/domains/home/components/notifications-bell";
import { HomePage } from "@/domains/home/home-page";
import {
  useBackgroundConversationListQuery,
  useConversationListQuery,
  useScheduledConversationListQuery,
} from "@/hooks/conversation-queries";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { usePageSurfaceStore } from "@/stores/page-surface-store";
import { mergeConversationLists } from "@/utils/conversation-cache";
import { navigateToConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";
import { Typography } from "@vellumai/design-library";

export function HomePageRoute() {
  const navigate = useNavigate();
  const location = useLocation();
  const assistantId = useActiveAssistantId();
  // Set when a notification row in the bell popover routed here — the page
  // opens that item's detail drawer on arrival.
  const initialFeedItemId =
    (location.state as ActivityLocationState | null)?.feedItemId ?? null;
  // Once consumed, replace the history entry without the feedItemId state so
  // a reload or Back to this entry doesn't re-open a drawer the user closed.
  const handleInitialFeedItemConsumed = useCallback(() => {
    void navigate(location.pathname + location.search, { replace: true });
  }, [navigate, location.pathname, location.search]);
  const setTopBarCenter = useChatLayoutSlotsStore.use.setTopBarCenter();
  const setPageSurface = usePageSurfaceStore.use.setSurface();
  const isMobile = useIsMobile();
  const { conversations: foregroundConversations } =
    useConversationListQuery(assistantId);
  // Recap/feed items can reference background and scheduled jobs, so the home
  // feed eagerly loads both lists to validate their "go to thread" links.
  // These queries are non-blocking — the page renders before they resolve.
  const { conversations: backgroundConversations } =
    useBackgroundConversationListQuery(assistantId, true);
  const { conversations: scheduledConversations } =
    useScheduledConversationListQuery(assistantId, true);
  const validConversationIds = useMemo(
    () =>
      new Set(
        mergeConversationLists(
          foregroundConversations,
          backgroundConversations,
          scheduledConversations,
        ).map((c) => c.conversationId),
      ),
    [foregroundConversations, backgroundConversations, scheduledConversations],
  );

  useEffect(() => {
    if (isMobile) {
      setTopBarCenter(
        <Typography
          variant="body-medium-default"
          className="text-[var(--content-secondary)]"
        >
          Activity
        </Typography>,
      );
    } else {
      setTopBarCenter(null);
    }
    return () => {
      setTopBarCenter(null);
    };
  }, [isMobile, setTopBarCenter]);

  // The page's content sits on `--surface-overlay`, so hand the shell the same
  // color: the themed surface then runs from the status bar, behind the header,
  // through the card, to the home indicator instead of stopping at the card's
  // rounded edge. Applied only on the native mobile shells — see the store.
  useEffect(() => {
    setPageSurface("var(--surface-overlay)");
    return () => {
      setPageSurface(null);
    };
  }, [setPageSurface]);

  return (
    <HomePage
      assistantId={assistantId}
      validConversationIds={validConversationIds}
      initialFeedItemId={initialFeedItemId}
      navigationKey={location.key}
      onInitialFeedItemConsumed={handleInitialFeedItemConsumed}
      onOpenConversation={(conversationId) =>
        navigateToConversation(navigate, conversationId)
      }
      onViewSchedule={(scheduleId) =>
        navigate(routes.schedules.detail(scheduleId))
      }
    />
  );
}
