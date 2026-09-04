/**
 * Route wiring for the Inspiration List (`/assistant/suggestions`).
 *
 * Everything the page cannot know on its own is resolved here: which list the
 * user is on, the catalog behind it, the daemon's progress, and what a click
 * does. The page itself stays presentational so a story renders exactly what
 * ships.
 *
 * The daemon's frozen list wins over the flag arm, the same rule the modal and
 * the pill follow, so a re-bucketed user keeps the checklist they started.
 *
 * The gate is `useEffectiveActivationListId`, the one every activation surface
 * shares, rather than the flag arm alone: the page is reachable by a bookmark,
 * and against an assistant too old for the `/v1/activation/*` routes every row
 * would offer a launch the daemon cannot link. Gated off, the route hands the
 * user back to chat, and it waits for `useActivationGatesSettled` before
 * deciding that, because both gates read as off while they are still
 * resolving.
 *
 * Mounted under `ActiveAssistantGate`, so `activeAssistantId` is resolved by
 * the time this renders and needs no second guard.
 */

import { useCallback, useMemo } from "react";
import { Navigate, useNavigate } from "react-router";

import { toast } from "@vellumai/design-library/components/toast";

import { useEffectiveActivationListId } from "@/hooks/use-activation-enabled";
import { useActivationGatesSettled } from "@/hooks/use-activation-gate";
import { useTranslation } from "@/i18n";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { navigateToConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";

import { useAvailableActivationList } from "../capabilities";
import { ActivationListPage } from "../components/activation-list-page";
import { useActivationProgress } from "../hooks/use-activation-progress";
import { useLaunchActivationTask } from "../hooks/use-launch-activation-task";

export function ActivationListRoute() {
  const navigate = useNavigate();
  const { t } = useTranslation("activation");
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const listId = useEffectiveActivationListId();
  const gatesSettled = useActivationGatesSettled();
  const { data: progress } = useActivationProgress();

  const { starters, items } = useAvailableActivationList(listId ?? "");
  const { launch, pendingTaskIds } = useLaunchActivationTask(listId ?? "");

  const tasks = useMemo(() => [...starters, ...items], [starters, items]);

  // The page is the point of the launch, so the user stays on it and the row
  // flips to Working; the conversation runs in the background. A failure has
  // nowhere else to surface, and one that already linked a conversation hands
  // it back so the user can drive the task by hand.
  const handleLaunch = useCallback(
    async (taskId: string) => {
      const result = await launch(taskId);
      if (result.ok || !result.error) {
        return;
      }
      const { conversationId } = result;
      toast.error(
        result.error,
        conversationId
          ? {
              action: {
                label: t("launch.openConversation"),
                onClick: () => {
                  navigateToConversation(navigate, conversationId);
                },
              },
            }
          : undefined,
      );
    },
    [launch, navigate, t],
  );

  if (listId === null) {
    // A gate that has not answered yet is not a gate that said no: on a cold
    // load the flag values and the assistant's version are both still in
    // flight, and redirecting on that would bounce every bookmark, reload and
    // new tab straight back to chat.
    return gatesSettled ? <Navigate to={routes.assistant} replace /> : null;
  }

  return (
    <ActivationListPage
      tasks={tasks}
      progress={progress?.tasks}
      pendingTaskIds={pendingTaskIds}
      onLaunch={(taskId) => {
        void handleLaunch(taskId);
      }}
      onOpenConversation={(conversationId) => {
        navigateToConversation(navigate, conversationId);
      }}
      assistantId={assistantId ?? undefined}
    />
  );
}
