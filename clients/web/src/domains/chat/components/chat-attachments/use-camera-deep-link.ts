import type { ReactElement } from "react";
import { useEffect } from "react";

import { useAttachmentFilePicker } from "@/domains/chat/components/chat-attachments/use-attachment-file-picker";
import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";

/**
 * How long a parked camera request stays live.
 *
 * The park exists for one race, a widget tap that lands before the composer
 * mounts, which resolves in seconds or not at all. Without a bound it never
 * expires: a tap whose `navigate(routes.assistant)` is bounced by a route
 * guard (unauthenticated, mid-onboarding) leaves the request sitting there
 * until some unrelated composer mount drains it and the camera opens out of
 * nowhere. The same minute the voice start allows itself
 * (`PENDING_VOICE_START_TTL_MS`), for the same reasons.
 */
export const PENDING_CAMERA_TTL_MS = 60_000;

interface UseCameraDeepLinkOptions {
  /** Receives the photo. Not called when the camera closes empty. */
  onFiles: (files: FileList) => void;
  /**
   * Whether this composer is the one that answers the command. Only the main
   * composer is: the app-editing panel and the onboarding tour render their
   * own, and a one-shot park would otherwise be spent by whichever mounted
   * first.
   */
  enabled: boolean;
}

interface UseCameraDeepLinkResult {
  /** Hidden camera `<input type="file">` the caller must render. */
  inputNode: ReactElement;
  /** True while the camera is up; see `useAttachmentFilePicker`. */
  pickerOpen: boolean;
}

/**
 * The composer's half of the camera deep link (`<scheme>://camera`, a Home
 * Screen widget's camera button). The global consumer parks the request and
 * navigates; this drains it and opens the camera.
 *
 * A camera input of its own rather than the add-to-chat sheet's: that sheet
 * mounts only where the composer offers one (a native shell or Android, on a
 * phone), and its rows close it before launching a picker precisely because an
 * unmounting input loses the selection. Nothing is open on this path, so the
 * hidden input is triggered directly and there is no close to sequence.
 *
 * Subscribed to the park rather than read once on mount, so a tap arriving
 * while the composer is already on screen (the app was in the foreground) is
 * answered too. The consume is one-shot, so a re-render cannot replay it.
 */
export function useCameraDeepLink({
  onFiles,
  enabled,
}: UseCameraDeepLinkOptions): UseCameraDeepLinkResult {
  const { openPicker, inputNode, pickerOpen } = useAttachmentFilePicker({
    onFiles,
    accept: "image/*",
    // What makes this the camera rather than the OS's own chooser.
    capture: "environment",
  });

  const pendingCameraAt = usePendingDeepLinkStore.use.pendingCameraAt();

  useEffect(() => {
    if (!enabled || pendingCameraAt === null) {
      return;
    }
    // Consumed whatever the age: an expired park is spent, not left to be
    // drained by a later mount.
    if (
      !usePendingDeepLinkStore
        .getState()
        .consumePendingCamera(PENDING_CAMERA_TTL_MS)
    ) {
      return;
    }
    openPicker();
  }, [enabled, openPicker, pendingCameraAt]);

  return { inputNode, pickerOpen };
}
