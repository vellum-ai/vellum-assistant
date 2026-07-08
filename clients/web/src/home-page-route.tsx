import { useCallback, useEffect, useMemo } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { requestComposerFocus } from "@/domains/chat/composer-focus";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { HomePage } from "@/domains/home/home-page";
import {
    useBackgroundConversationListQuery,
    useConversationListQuery,
    useScheduledConversationListQuery,
} from "@/hooks/conversation-queries";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { mergeConversationLists } from "@/utils/conversation-cache";
import { routes } from "@/utils/routes";
import { Typography } from "@vellumai/design-library";

export function HomePageRoute() {
  const navigate = useNavigate();
  const location = useLocation();
  const { scheduleId } = useParams();
  const assistantId = useActiveAssistantId();

  // The Activity page is one component served at two URL families: `/home`
  // (Notifications) and `/schedules[/:id]` (Schedules). Derive the active tab
  // and focused schedule from the URL so both are bookmarkable and the back
  // button works, then navigate on tab / selection changes below.
  const onSchedulesRoute =
    location.pathname === routes.schedules.root ||
    location.pathname.startsWith(`${routes.schedules.root}/`);
  const activeTab = onSchedulesRoute ? "schedules" : "notifications";
  const routeScheduleId = scheduleId ?? null;

  const handleTabChange = useCallback(
    (tab: "schedules" | "notifications") => {
      navigate(tab === "schedules" ? routes.schedules.root : routes.home);
    },
    [navigate],
  );

  const handleSelectScheduleId = useCallback(
    (id: string | null) => {
      navigate(id ? routes.schedules.detail(id) : routes.schedules.root);
    },
    [navigate],
  );
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
      activeTab={activeTab}
      onTabChange={handleTabChange}
      routeScheduleId={routeScheduleId}
      onSelectScheduleId={handleSelectScheduleId}
      onStartNewChat={() => {
        useViewerStore.getState().setMainView("chat");
        const draftConversationId = createDraftConversationId();
        useConversationStore
          .getState()
          .setActiveConversationId(draftConversationId);
        navigate(routes.conversation(draftConversationId));
        requestComposerFocus();
      }}
      onOpenConversation={(conversationId) =>
        navigate(routes.conversation(conversationId))
      }
    />
  );
}
