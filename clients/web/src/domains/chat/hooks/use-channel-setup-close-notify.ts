import { useEffect, useRef } from "react";

import { notifyChannelSetupClosed } from "@/domains/chat/channel-setup-close-notify";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useViewerStore } from "@/stores/viewer-store";

/**
 * Fires the channel-setup close auto-notify when the setup drawer closes.
 *
 * Watches the viewer store's `activeChannelSetup`: a non-null → null
 * transition means the drawer was dismissed — every close affordance (the
 * DetailShell X, the connected-state Close button, Escape, and the Slack
 * save-success auto-close) funnels through `closeChannelSetup`, which is the
 * only clearer of that field. The standalone Contacts/Settings setup flow
 * never touches the viewer store, so it can't trigger a notify.
 *
 * Mobile is excluded: there the drawer is closed immediately in favor of a
 * redirect to the Contacts setup page, so the close is a hand-off, not a
 * dismissal.
 */
export function useChannelSetupCloseNotify(): void {
  const activeChannelSetup = useViewerStore.use.activeChannelSetup();
  const isMobile = useIsMobile();
  const prevRef = useRef(activeChannelSetup);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = activeChannelSetup;
    if (prev && activeChannelSetup === null && !isMobile) {
      void notifyChannelSetupClosed(prev);
    }
  }, [activeChannelSetup, isMobile]);
}
