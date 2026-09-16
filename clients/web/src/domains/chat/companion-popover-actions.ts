import type { CompanionPopoverAnswer } from "@vellumai/ipc-contract";

import {
  closeCompanionPicker,
  currentCompanionPopover,
  offeredSurface,
  pendingApprovals,
  useCompanionPopoverStore,
  withdrawSurfaceFromCompanion,
} from "@/domains/chat/companion-popover";
import { handleConfirmationSubmit } from "@/domains/chat/confirmation-actions";
import { handleSecretSubmit } from "@/domains/chat/secret-actions";
import { handleSurfaceAction } from "@/domains/chat/surface-actions";
import { captureError } from "@/lib/sentry/capture-error";
import { openSystemPermissionSettings } from "@/runtime/system-permissions";
import { setPreferredInputDeviceId } from "@/utils/voice-input-device";

/** Surfaces with an action from the popover still being submitted. */
const surfacesSubmitting = new Set<string>();

/**
 * Act on a press on the companion's popover, in the window that holds the
 * approvals, the credential request or the surface it showed.
 *
 * An approval is answered by its own request id, so a press on one row of the
 * list lands as long as that approval is still pending, whatever else joined
 * or left the list meanwhile. Every other answer is dropped when `popoverId`
 * no longer names what the popover would show: the request may have been
 * answered here first, or a newer surface put up, between the push that drew
 * the buttons and the press arriving.
 */
export async function answerCompanionPopover(
  popoverId: string,
  answer: CompanionPopoverAnswer,
): Promise<void> {
  switch (answer.kind) {
    case "allow":
    case "deny":
    case "settings": {
      const approval = pendingApprovals().find(
        (candidate) => candidate.confirmation.requestId === answer.itemId,
      );
      if (approval === undefined) {
        return;
      }
      const popover = currentCompanionPopover();
      const permission =
        popover?.kind === "approvals"
          ? popover.items.find((item) => item.id === answer.itemId)?.permission
          : undefined;
      await handleConfirmationSubmit(
        answer.kind === "deny" ? "deny" : "allow",
        approval.toolCall,
      );
      if (answer.kind !== "settings" || permission === undefined) {
        return;
      }
      try {
        await openSystemPermissionSettings(permission);
      } catch (err) {
        captureError(err, { context: "companion_popover_open_settings" });
      }
      return;
    }
    default:
      break;
  }

  const popover = currentCompanionPopover();
  if (popover === undefined || popover.id !== popoverId) {
    return;
  }

  switch (answer.kind) {
    case "secret":
      if (popover.kind === "secret") {
        await handleSecretSubmit(answer.value, "store");
      }
      return;
    case "action": {
      if (popover.kind !== "card" || surfacesSubmitting.has(popoverId)) {
        return;
      }
      const action = offeredSurface()?.actions?.find(
        (candidate) => candidate.id === answer.actionId,
      );
      if (action === undefined) {
        return;
      }
      // Claimed for the length of the submission, so a second press that
      // crossed the first on its way here does not post the action again.
      surfacesSubmitting.add(popoverId);
      try {
        await handleSurfaceAction(popoverId, action.id, action.data);
      } finally {
        surfacesSubmitting.delete(popoverId);
      }
      return;
    }
    case "pick":
      if (popover.kind === "microphones") {
        // System Default, or a microphone the popover listed. The running
        // capture moves onto it by watching the saved preference.
        if (
          answer.optionId === "" ||
          popover.options.some((option) => option.id === answer.optionId)
        ) {
          setPreferredInputDeviceId(answer.optionId);
          closeCompanionPicker();
        }
        return;
      }
      if (popover.kind === "voices") {
        // Left open, so several voices can be tried in a row. The pick lands
        // on the assistant's next spoken turn.
        const voices = useCompanionPopoverStore.getState().voices;
        if (
          voices !== null &&
          popover.groups.some((group) =>
            group.voices.some((voice) => voice.id === answer.optionId),
          )
        ) {
          voices.select(answer.optionId);
        }
      }
      return;
    case "open":
    case "dismiss":
      // `open` has already brought the app forward, which is where an approval
      // or a credential is answered from then. A surface the user went to, or
      // waved off, stops being offered.
      if (popover.kind === "card" || popover.kind === "surface") {
        withdrawSurfaceFromCompanion(popoverId);
      }
      if (popover.kind === "microphones" || popover.kind === "voices") {
        closeCompanionPicker();
      }
      return;
    default:
      return;
  }
}
