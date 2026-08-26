import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";
import { conversationIdForPath } from "@/utils/routes";

/**
 * How long a parked open-conversations request stays live.
 *
 * The park exists for one race, a widget tap that lands before the layout is
 * mounted on a settled route, which resolves in seconds or not at all. The same
 * minute the camera park allows itself (`PENDING_CAMERA_TTL_MS`), for the same
 * reason: a tap whose landing is bounced by a route guard must not throw the
 * list open on top of some unrelated later navigation.
 */
export const PENDING_CONVERSATION_LIST_TTL_MS = 60_000;

interface UseConversationListDeepLinkOptions {
  /** Whether the layout is drawing its mobile shape. */
  isMobile: boolean;
  /** Bring the mobile drawer in. */
  openDrawer: () => void;
  /** Uncollapse the sidebar a wider window keeps the list in. */
  expandSidebar: () => void;
}

/**
 * The layout's half of the open-conversations deep link
 * (`<scheme>://conversations`, the Home Screen widgets' unread chip and unread
 * line). The global consumer parks the request and lands on the chat; this
 * drains it into whichever shape the list has on this viewport.
 *
 * Parked rather than acted on where it arrives because the list belongs to
 * `ChatLayout`, which is not mounted when the tap cold-launches the app and
 * never mounts on settings / logs / account routes.
 *
 * Call this AFTER the layout's close-the-drawer-on-navigation effect. Effects
 * run in hook order, so an open granted here on the same commit as a navigation
 * outlives that close rather than being undone by it.
 */
export function useConversationListDeepLink({
  isMobile,
  openDrawer,
  expandSidebar,
}: UseConversationListDeepLinkOptions): void {
  const pendingAt = usePendingDeepLinkStore.use.pendingConversationListAt();
  const { pathname } = useLocation();
  /**
   * The park this already opened the drawer for once, so the hold below is
   * worth exactly one re-open. A landing that never reaches a conversation
   * (a guard bounced it, the account has nowhere to settle) would otherwise
   * throw the drawer back open on every navigation until the park ages out,
   * including the ones the user makes from inside the drawer.
   */
  const openedForRef = useRef<number | null>(null);

  useEffect(() => {
    if (pendingAt === null) {
      return;
    }
    const consume = () =>
      usePendingDeepLinkStore.getState().consumePendingConversationList();
    // Spent whatever the age: a park whose landing never settled (a route
    // guard bounced it, the account is mid-onboarding) must not throw the list
    // open minutes later.
    if (Date.now() - pendingAt > PENDING_CONVERSATION_LIST_TTL_MS) {
      consume();
      return;
    }
    if (!isMobile) {
      // A wide window keeps the list on screen as the sidebar, so the whole
      // request is making sure it is not collapsed. Nothing here is waiting on
      // a route, so it is spent at once.
      expandSidebar();
      consume();
      return;
    }
    openDrawer();
    // Spent once the route names a conversation, or once this park has already
    // bought its one re-open. A tap that lands on `/assistant` is
    // replace-navigated off it a beat later (`useConversationLoader`), and a
    // park spent before that would have its drawer closed by the very
    // navigation it was waiting on, so the first open on an unsettled route
    // holds the request for that one navigation and no further.
    if (
      conversationIdForPath(pathname) !== null ||
      openedForRef.current === pendingAt
    ) {
      consume();
      return;
    }
    openedForRef.current = pendingAt;
  }, [pendingAt, isMobile, pathname, openDrawer, expandSidebar]);
}
