import { useEffect, useRef } from "react";

import { notifyChannelSetupClosed } from "@/domains/chat/channel-setup-close-notify";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { ChannelSetupPayload } from "@/stores/viewer-store";
import { useViewerStore } from "@/stores/viewer-store";

/**
 * Fires the channel-setup close auto-notify when the setup drawer closes.
 *
 * Watches wizard *visibility* — `mainView === "channel-setup"` with a
 * payload set — not just the payload. Every explicit close affordance (the
 * DetailShell X, the connected-state Close button, Escape, the Slack
 * save-success auto-close) funnels through `closeChannelSetup`, which clears
 * the payload; but opening another right-hand panel (e.g. tool detail)
 * replaces `mainView` while leaving the payload intact, and the wizard does
 * not return when that panel closes (`resolveViewBefore` collapses overlay
 * views). Both count as the wizard going away, so both notify. The
 * standalone Contacts/Settings setup flow never touches the viewer store, so
 * it can't trigger a notify.
 *
 * Mobile is excluded: there the drawer is closed immediately in favor of a
 * redirect to the Contacts setup page, so the close is a hand-off, not a
 * dismissal.
 */
export function useChannelSetupCloseNotify(): void {
  const mainView = useViewerStore.use.mainView();
  const activeChannelSetup = useViewerStore.use.activeChannelSetup();
  const isMobile = useIsMobile();

  const visiblePayload =
    mainView === "channel-setup" ? activeChannelSetup : null;
  const prevVisiblePayloadRef = useRef<ChannelSetupPayload | null>(
    visiblePayload,
  );

  useEffect(() => {
    const prev = prevVisiblePayloadRef.current;
    prevVisiblePayloadRef.current = visiblePayload;
    if (prev && visiblePayload === null && !isMobile) {
      void notifyChannelSetupClosed(prev);
    }
  }, [visiblePayload, isMobile]);
}
