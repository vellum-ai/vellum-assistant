/**
 * The activation checklist's modal surfaces, mounted beside the chat layout.
 *
 * The checklist draws in two places, so it mounts in two: this controller owns
 * the overlay, and `ActivationSuggestionsPillHost` owns the top-bar pill. Both
 * read the same gate stack, so they cannot disagree about whether the feature
 * is on or how far along the user is, and the store's reopen flag is what lets
 * the pill hand control back to this one.
 */

import { useEffect, useRef, type ReactNode } from "react";

import { useActivationChecklistArm } from "@/hooks/use-activation-checklist-flag";
import { emitActivationEvent } from "@/utils/activation-telemetry";

import { useActivationUiStore } from "./activation-ui-store";
import { ActivationWelcomeModal } from "./components/activation-welcome-modal";
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
  const arm = useActivationChecklistArm();
  const { data: progress } = useActivationProgress();
  const modalReopened = useActivationUiStore.use.modalReopened();
  const closeModal = useActivationUiStore.use.closeModal();
  const { dismiss } = useDismissActivation(listId);

  // The celebration is a distinct dismissal: it records that the user has seen
  // it, which is what retires the checklist for good.
  const variant = surface === "all-done" ? "all-done" : "welcome";
  const open =
    surface === "modal" ||
    surface === "all-done" ||
    (surface === "pill" && modalReopened);

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
    emitActivationEvent("activation_modal_shown", { arm, listId });
  }, [arm, listId, open, variant]);

  if (!open || listId === null || !progress) {
    return null;
  }

  const handleDismiss = (): void => {
    closeModal();
    // A pill the user reopened has already been dismissed once. Recording it
    // again would only rewrite the same timestamp.
    if (surface === "modal" || surface === "all-done") {
      dismiss(variant === "all-done" ? "all-done" : "modal");
    }
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
