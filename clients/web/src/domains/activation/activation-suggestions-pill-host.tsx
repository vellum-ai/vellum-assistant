/**
 * The suggestions pill, wired to the checklist's gate stack.
 *
 * Passed to the chat layout header as its `topBarPill`, a slot of its own that
 * the header seats ahead of the route's own accessory. Registering the pill
 * through `setTopBarRightSlot` instead would erase whatever the chat page's
 * header registration had put there, since that slot has a single writer and
 * is rewritten on every conversation change.
 *
 * Shows only while the checklist is in its dismissed-but-unfinished state, so
 * it retires itself once the third starter lands.
 */

import type { ReactNode } from "react";

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
        emitActivationEvent("activation_pill_clicked");
        openModal();
      }}
    />
  );
}
