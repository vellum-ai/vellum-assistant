import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router";

import { CameraCaptureOverlay } from "@/domains/chat/components/chat-attachments/camera-capture-overlay";
import {
  isLiveVoiceSessionActive,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";
import { conversationIdForPath } from "@/utils/routes";

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
   * Whether this composer is the one that answers the command. Only
   * `ChatMainPanel`'s is: the onboarding tour renders a composer of its own,
   * and a one-shot park would otherwise be spent by whichever mounted first.
   * One `ChatMainPanel` is on screen at a time (its two layout branches, the
   * app-editing split and the plain chat, are mutually exclusive), so that
   * gate leaves exactly one taker. The park's address tells composers on
   * different routes apart; this tells apart the two that share one.
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
 * answered too. The consume is one-shot, so a re-render cannot replay it, and a
 * drain landing during a live-voice call spends the request without raising
 * anything: the call owns the one camera layer.
 *
 * A park names the conversation it is for, and this only drains one addressed
 * to the route it is mounted on. Without that, a composer on the route a tap is
 * navigating *away* from spends the park on a viewfinder its own unmount takes
 * down, and the composer the tap was for finds nothing waiting.
 */
export function useCameraDeepLink({
  onFiles,
  enabled,
}: UseCameraDeepLinkOptions): UseCameraDeepLinkResult {
  const [captureOpen, setCaptureOpen] = useState(false);
  const pendingCamera = usePendingDeepLinkStore.use.pendingCamera();
  // The conversation this composer is bound to, read off the route rather than
  // off the active conversation in the store. The store's id is set to the
  // draft *before* the router leaves the old route, so every mounted composer
  // would answer to it; the route is the one thing that still tells the
  // outgoing composer apart from the one being navigated to.
  const routeConversationId = conversationIdForPath(useLocation().pathname);

  useEffect(() => {
    if (!enabled || pendingCamera === null) {
      return;
    }
    const consume = () =>
      usePendingDeepLinkStore.getState().consumePendingCamera();
    // Spent whatever the age: an expired park is not left behind for a later
    // mount to drain.
    if (Date.now() - pendingCamera.parkedAt > PENDING_CAMERA_TTL_MS) {
      consume();
      return;
    }
    // Addressed to some other conversation: left parked, untouched, for the
    // composer it names. Spending it here would cost the command outright,
    // since the park is one-shot.
    if (pendingCamera.targetConversationId !== routeConversationId) {
      return;
    }
    // A running call owns the camera. `useVoiceCamera` is a hook over one
    // native preview layer, so a second instance raised here starts and stops
    // the viewfinder the room is still showing, while the room's own hook goes
    // on believing its camera is up.
    //
    // The request is spent rather than held back until the call ends. A call
    // runs longer than the park's minute, so holding one either ages it out
    // anyway or raises a viewfinder long after the tap that asked for it, which
    // is the surprise the TTL exists to prevent. Dropping it costs a command
    // the user can reissue, and the call carries a camera control of its own.
    //
    // The session phase is the whole gate rather than "the room's viewfinder is
    // open": nothing publishes the latter, since it lives in the room's own
    // `useVoiceCamera` instance.
    if (isLiveVoiceSessionActive(useLiveVoiceStore.getState().state)) {
      consume();
      return;
    }
    // Consumed last, after the surface is actually raised: everything above is
    // a reason to spend the request deliberately, and nothing between here and
    // the park can fail with the command silently gone.
    setCaptureOpen(true);
    consume();
  }, [enabled, pendingCamera, routeConversationId]);

  const closeCapture = useCallback(() => setCaptureOpen(false), []);

  return {
    overlayNode: captureOpen ? (
      <CameraCaptureOverlay onCapture={onFiles} onClose={closeCapture} />
    ) : null,
    captureOpen,
  };
}
