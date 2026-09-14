import type { CompanionPopoverAnswer } from "@vellumai/ipc-contract";

import {
  currentCompanionPopover,
  offeredSurface,
  withdrawSurfaceFromCompanion,
} from "@/domains/chat/companion-popover";
import { handleConfirmationSubmit } from "@/domains/chat/confirmation-actions";
import { handleSurfaceAction } from "@/domains/chat/surface-actions";
import { captureError } from "@/lib/sentry/capture-error";
import { openSystemPermissionSettings } from "@/runtime/system-permissions";

/**
 * Act on a press on the companion's popover, in the window that holds the
 * approval or the surface it showed.
 *
 * Dropped when `popoverId` no longer names what the popover would show: the
 * approval may have been answered here first, or a newer surface put up,
 * between the push that drew the buttons and the press arriving.
 */
export async function answerCompanionPopover(
  popoverId: string,
  answer: CompanionPopoverAnswer,
): Promise<void> {
  const popover = currentCompanionPopover();
  if (popover === undefined || popover.id !== popoverId) {
    return;
  }

  if (popover.kind === "approval") {
    switch (answer.kind) {
      case "allow":
        await handleConfirmationSubmit("allow");
        return;
      case "deny":
        await handleConfirmationSubmit("deny");
        return;
      case "settings":
        await handleConfirmationSubmit("allow");
        if (popover.permission === undefined) {
          return;
        }
        try {
          await openSystemPermissionSettings(popover.permission);
        } catch (err) {
          captureError(err, { context: "companion_popover_open_settings" });
        }
        return;
      default:
        // `open` has already brought the app forward on the card, which is
        // where it is answered. An approval cannot be dismissed: the turn is
        // waiting on it.
        return;
    }
  }

  switch (answer.kind) {
    case "action": {
      const action = offeredSurface()?.actions?.find(
        (candidate) => candidate.id === answer.actionId,
      );
      if (action === undefined) {
        return;
      }
      await handleSurfaceAction(popoverId, action.id, action.data);
      return;
    }
    case "open":
    case "dismiss":
      withdrawSurfaceFromCompanion(popoverId);
      return;
    default:
      return;
  }
}
