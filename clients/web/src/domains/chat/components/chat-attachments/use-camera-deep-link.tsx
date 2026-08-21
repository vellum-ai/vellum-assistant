import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";

import { CameraCaptureOverlay } from "@/domains/chat/components/chat-attachments/camera-capture-overlay";
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
  onFiles: (files: File[]) => void;
  /**
   * Whether this composer is the one that answers the command. Only the main
   * composer is: the app-editing panel and the onboarding tour render their
   * own, and a one-shot park would otherwise be spent by whichever mounted
   * first.
   */
  enabled: boolean;
}

interface UseCameraDeepLinkResult {
  /** The capture surface while one is up, and nothing the rest of the time. */
  overlayNode: ReactNode;
  /** True while the capture surface is up. */
  captureOpen: boolean;
}

/**
 * The composer's half of the camera deep link (`<scheme>://camera`, a Home
 * Screen widget's camera button). The global consumer parks the request and
 * navigates; this drains it and raises the viewfinder.
 *
 * The camera is {@link CameraCaptureOverlay}, a surface of this app's own
 * rather than the system camera a hidden `<input capture>` would raise. That is
 * not a preference: the request arrives from outside the web view and so
 * carries no DOM user activation, which iOS WKWebView requires before it will
 * present a file input's picker at all. See that module for the whole of it.
 *
 * Subscribed to the park rather than read once on mount, so a tap arriving
 * while the composer is already on screen (the app was in the foreground) is
 * answered too. The consume is one-shot, so a re-render cannot replay it.
 */
export function useCameraDeepLink({
  onFiles,
  enabled,
}: UseCameraDeepLinkOptions): UseCameraDeepLinkResult {
  const [captureOpen, setCaptureOpen] = useState(false);
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
    setCaptureOpen(true);
  }, [enabled, pendingCameraAt]);

  const closeCapture = useCallback(() => setCaptureOpen(false), []);

  return {
    overlayNode: captureOpen ? (
      <CameraCaptureOverlay onCapture={onFiles} onClose={closeCapture} />
    ) : null,
    captureOpen,
  };
}
