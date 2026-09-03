/**
 * Route wiring for the Inspiration List (`/assistant/suggestions`).
 *
 * Everything the page cannot know on its own is resolved here: which list the
 * user is on, the catalog behind it, the daemon's progress, and what a click
 * does. The page itself stays presentational so a story renders exactly what
 * ships.
 *
 * The daemon's frozen list wins over the flag arm, the same rule the modal and
 * the pill follow, so a re-bucketed user keeps the checklist they started. An
 * arm that selects no list has nothing to show and hands the user back to
 * chat rather than leaving them on an empty page.
 *
 * Mounted under `ActiveAssistantGate`, so `activeAssistantId` is resolved by
 * the time this renders and needs no second guard.
 */

import { useMemo } from "react";
import { Navigate, useNavigate } from "react-router";

import {
  resolveActivationListId,
  useActivationChecklistArm,
} from "@/hooks/use-activation-checklist-flag";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { navigateToConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";

import {
  taskIsAvailable,
  useAvailableCapabilityTags,
} from "../capabilities";
import { useActivationList } from "../catalog";
import { ActivationListPage } from "../components/activation-list-page";
import { useActivationProgress } from "../hooks/use-activation-progress";
import { useLaunchActivationTask } from "../hooks/use-launch-activation-task";

export function ActivationListRoute() {
  const navigate = useNavigate();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const arm = useActivationChecklistArm();
  const armListId = resolveActivationListId(arm);
  const { data: progress } = useActivationProgress();
  const listId = progress?.listId ?? armListId;

  const { starters, items } = useActivationList(listId ?? "");
  const availableTags = useAvailableCapabilityTags();
  const { launch, pendingTaskId } = useLaunchActivationTask(listId ?? "");

  const tasks = useMemo(
    () =>
      [...starters, ...items].filter((task) =>
        taskIsAvailable(task, availableTags),
      ),
    [starters, items, availableTags],
  );

  if (armListId === null) {
    return <Navigate to={routes.assistant} replace />;
  }

  return (
    <ActivationListPage
      tasks={tasks}
      progress={progress?.tasks ?? {}}
      pendingTaskId={pendingTaskId}
      // The page is the point of the launch, so the user stays on it and the
      // row flips to Working; the conversation runs in the background.
      onLaunch={(taskId) => {
        void launch(taskId);
      }}
      onOpenConversation={(conversationId) => {
        navigateToConversation(navigate, conversationId);
      }}
      assistantId={assistantId ?? undefined}
    />
  );
}
