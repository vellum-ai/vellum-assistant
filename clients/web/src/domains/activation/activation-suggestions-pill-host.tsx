/**
 * The suggestions pill, wired to the checklist's gate stack.
 *
 * Composed into the chat layout's top-bar accessory at the route level rather
 * than registered through `setTopBarRightSlot`. That slot already has a single
 * writer, the chat page's own header registration, and a second effect writing
 * it would erase whatever the other put there on every conversation change.
 * The notification bell is composed at the route for the matching reason.
 *
 * Shows only while the checklist is in its dismissed-but-unfinished state, so
 * it retires itself once the third starter lands.
 */

import type { ReactNode } from "react";

import { useActivationChecklistArm } from "@/hooks/use-activation-checklist-flag";
import { emitActivationEvent } from "@/utils/activation-telemetry";

import { useActivationUiStore } from "./activation-ui-store";
import { getActivationListIds } from "./catalog";
import { ActivationSuggestionsPill } from "./components/activation-suggestions-pill";
import { useActivationProgress } from "./hooks/use-activation-progress";
import {
  doneStarterCount,
  useActivationVisibility,
} from "./hooks/use-activation-visibility";

export function ActivationSuggestionsPillHost(): ReactNode {
  const { surface, listId } = useActivationVisibility();
  const arm = useActivationChecklistArm();
  const { data: progress } = useActivationProgress();
  const openModal = useActivationUiStore.use.openModal();

  if (surface !== "pill" || listId === null || !progress) {
    return null;
  }

  return (
    <ActivationSuggestionsPill
      done={doneStarterCount(progress, listId)}
      total={getActivationListIds(listId).starters.length}
      onClick={() => {
        emitActivationEvent("activation_pill_clicked", { arm, listId });
        openModal();
      }}
    />
  );
}
