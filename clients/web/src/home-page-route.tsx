import { useEffect, useMemo } from "react";
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
import { mergeConversationLists } from "@/utils/conversation-cache";
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
  const setTopBarCenter = useChatLayoutSlotsStore.use.setTopBarCenter();
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
    return () => { setTopBarCenter(null); };
  }, [isMobile, setTopBarCenter]);

  return (
    <HomePage
      assistantId={assistantId}
      validConversationIds={validConversationIds}
      initialFeedItemId={initialFeedItemId}
      onOpenConversation={(conversationId) =>
        navigate(routes.conversation(conversationId))
      }
      onViewSchedule={(scheduleId) =>
        navigate(routes.schedules.detail(scheduleId))
      }
    />
  );
}
