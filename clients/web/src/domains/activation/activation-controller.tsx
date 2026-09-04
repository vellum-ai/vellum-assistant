/**
 * The activation checklist's modal surfaces, mounted beside the chat layout.
 *
 * The checklist draws in two places, so it mounts in two: this controller owns
 * the overlay, and `ActivationSuggestionsPillHost` owns the top-bar pill. Both
 * read the same gate stack, so they cannot disagree about whether the feature
 * is on or how far along the user is, and the store's reopen flag is what lets
 * the pill hand control back to this one.
 *
 * The completion step of the funnel is watched from here too. The controller
 * is mounted for as long as the chat layout is, which is the whole session a
 * background task can finish in.
 */

import { useEffect, useRef, type ReactNode } from "react";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { emitActivationEvent } from "@/utils/activation-telemetry";

import { useActivationUiStore } from "./activation-ui-store";
import { ActivationWelcomeModal } from "./components/activation-welcome-modal";
import { useActivationCompletionTelemetry } from "./hooks/use-activation-completion-telemetry";
import { useActivationProgress } from "./hooks/use-activation-progress";
import { useActivationVisibility } from "./hooks/use-activation-visibility";
import { useDismissActivation } from "./hooks/use-dismiss-activation";

/**
 * The welcome and celebration modals, mounted beside the chat layout.
 *
 * Renders nothing at all when the gate stack says so, which covers every
 * off state: the flag arm, a daemon without the routes, onboarding, the
 * in-chat tour, and a checklist the user has already finished.
 */
export function ActivationController(): ReactNode {
  const { surface, listId } = useActivationVisibility();
  const { data: progress } = useActivationProgress();
  const modalReopened = useActivationUiStore.use.modalReopened();
  const closeModal = useActivationUiStore.use.closeModal();
  const closedSurface = useActivationUiStore.use.closedSurface();
  const setClosedSurface = useActivationUiStore.use.setClosedSurface();
  const resetTransientState = useActivationUiStore.use.resetTransientState();
  const { dismiss } = useDismissActivation(listId);
  useActivationCompletionTelemetry();

  // An expanded row, Show More, a pill reopen and a dismissal made ahead of
  // the daemon all belong to one assistant's checklist. Switching assistants
  // without remounting starts the next one from the default view.
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  useEffect(() => {
    resetTransientState();
  }, [activeAssistantId, resetTransientState]);

  // The celebration is a distinct dismissal: it records that the user has seen
  // it, which is what retires the checklist for good.
  const variant = surface === "all-done" ? "all-done" : "welcome";
  const open =
    surface !== closedSurface &&
    (surface === "modal" ||
      surface === "all-done" ||
      (surface === "pill" && modalReopened));

  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      shownFor.current = null;
      return;
    }
    if (shownFor.current === variant) {
      return;
    }
    shownFor.current = variant;
    emitActivationEvent("activation_modal_shown");
  }, [open, variant]);

  if (!open || listId === null || !progress) {
    return null;
  }

  const handleDismiss = (): void => {
    closeModal();
    // A pill the user reopened has already been dismissed once. Recording it
    // again would only rewrite the same timestamp, and the reopen flag the
    // line above cleared is all that held it open.
    if (surface !== "modal" && surface !== "all-done") {
      return;
    }
    setClosedSurface(surface);
    dismiss(variant === "all-done" ? "all-done" : "modal");
  };

  return (
    <ActivationWelcomeModal
      open
      listId={listId}
      progress={progress}
      variant={variant}
      onDismiss={handleDismiss}
    />
  );
}
