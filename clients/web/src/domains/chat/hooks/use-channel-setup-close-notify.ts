import { useEffect } from "react";

import { notifyChannelSetupClosed } from "@/domains/chat/channel-setup-close-notify";
import { MOBILE_MEDIA_QUERY } from "@/hooks/use-is-mobile";
import type { ChannelSetupPayload } from "@/stores/viewer-store";
import { useViewerStore } from "@/stores/viewer-store";

/**
 * Fires the channel-setup close auto-notify when the setup drawer goes away.
 *
 * Watches wizard *visibility* — `mainView === "channel-setup"` with a payload
 * set — via a direct store subscription rather than render-path selectors, so
 * every store transition is observed no matter which React tree (or route)
 * triggered it: the DetailShell X / Close button / Escape / save-success
 * auto-close (all funnel through `closeChannelSetup`), another right-hand
 * panel replacing the drawer, and the `setMainView("chat")` calls made from
 * non-chat routes while the drawer is still open. Mount once from an
 * always-mounted layer (RootLayout). The standalone Contacts/Settings setup
 * flow never touches the viewer store, so it can't trigger a notify.
 *
 * Narrow viewports are excluded here: there the drawer close is a hand-off —
 * ChatContentLayout's mobile fallback redirects to the Contacts setup page
 * and sends the distinct hand-off signal itself (see
 * `notifyChannelSetupHandedOff`), so a dismissal notify would be wrong.
 */
export function useChannelSetupCloseNotify(): void {
  useEffect(() => {
    return useViewerStore.subscribe((state, prevState) => {
      const prev = visibleWizard(prevState);
      const now = visibleWizard(state);
      if (!prev || prev === now) {
        return;
      }
      // Same wizard re-shown (e.g. the assistant re-issued ui_show for the
      // channel it already has open): a fresh payload object, not a close.
      if (
        now &&
        now.channel === prev.channel &&
        now.conversationId === prev.conversationId
      ) {
        return;
      }
      if (window.matchMedia(MOBILE_MEDIA_QUERY).matches) {
        return;
      }
      void notifyChannelSetupClosed(prev);
    });
  }, []);
}

function visibleWizard(state: {
  mainView: string;
  activeChannelSetup: ChannelSetupPayload | null;
}): ChannelSetupPayload | null {
  return state.mainView === "channel-setup" ? state.activeChannelSetup : null;
}
