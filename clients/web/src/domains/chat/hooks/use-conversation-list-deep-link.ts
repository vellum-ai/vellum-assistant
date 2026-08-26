import { useEffect } from "react";
import { useLocation } from "react-router";

import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";
import { conversationIdForPath } from "@/utils/routes";

/**
 * How long a parked open-conversations request stays live.
 *
 * The park exists for one race, a widget tap that lands before the layout is
 * mounted on a settled route, which resolves in seconds or not at all. The same
 * minute the camera park allows itself (`PENDING_CAMERA_TTL_MS`), for the same
 * reason: a tap whose landing never settles (a route guard bounced it, the
 * assistant is still waking) must not throw the list open on top of some
 * unrelated later navigation.
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
 * ## Why the drawer waits for a conversation
 *
 * The layout closes the drawer on every navigation, and a landing on
 * `/assistant` replace-navigates to a conversation a beat after arrival
 * (`useConversationLoader`). A drawer opened on the index would therefore be
 * shut by the very navigation it was waiting on.
 *
 * So the request waits rather than opening early and re-asserting itself. The
 * two are not equivalent: a drawer that reopens after each navigation is one
 * the user cannot get out of, and picking a conversation from it would land
 * them on that conversation with the list thrown straight back over the top.
 * Waiting means there is no drawer on screen to fight over, and the request is
 * spent by the single open it was asking for. A landing that never settles
 * inside the TTL drops the request instead, which is the honest outcome: the
 * list is not somewhere to arrive at a minute late.
 *
 * Call this AFTER the layout's close-the-drawer-on-navigation effect. Effects
 * run in hook order, so the open granted on the settling navigation's own
 * commit outlives that close rather than being undone by it.
 */
export function useConversationListDeepLink({
  isMobile,
  openDrawer,
  expandSidebar,
}: UseConversationListDeepLinkOptions): void {
  const pendingAt = usePendingDeepLinkStore.use.pendingConversationListAt();
  const { pathname } = useLocation();

  useEffect(() => {
    if (pendingAt === null) {
      return;
    }
    const consume = () =>
      usePendingDeepLinkStore.getState().consumePendingConversationList();
    // Spent whatever the age: an expired park is not left behind for a later
    // navigation to drain.
    if (Date.now() - pendingAt > PENDING_CONVERSATION_LIST_TTL_MS) {
      consume();
      return;
    }
    if (!isMobile) {
      // A wide window keeps the list on screen as the sidebar, so the whole
      // request is making sure it is not collapsed. Nothing is waiting on a
      // route here: uncollapsing survives navigation, so it is done at once.
      expandSidebar();
      consume();
      return;
    }
    // Held, untouched, until the landing settles; see the note above.
    if (conversationIdForPath(pathname) === null) {
      return;
    }
    openDrawer();
    consume();
  }, [pendingAt, isMobile, pathname, openDrawer, expandSidebar]);
}
