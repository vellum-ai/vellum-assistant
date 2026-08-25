/**
 * Bus consumer for `feed_toast` SSE events.
 *
 * The toast exists for one job: async work finished and you should look at it
 * now, and you happen to be in the app. The daemon decides what is
 * toast-worthy; this decides whether to draw one, because the two facts that
 * settle it are client-side.
 *
 *   - **In-app only.** An unfocused window drops the event and lets the system
 *     notification take over. They never both fire, which is also enforced from
 *     the other side, in `use-notification-intent-sync`.
 *   - **Stacks and collapses.** Three or more inside a short window become one
 *     "3 runs finished", because only the client knows what is already on
 *     screen.
 *
 * Dismissing a toast is not "read": read state lives on the feed row, and the
 * row is still there afterwards. Missing a toast entirely costs nothing for the
 * same reason.
 *
 * References:
 * - EVENT_BUS.md: bus subscription contract
 * - api/events/feed-toast.ts: the wire contract
 */

import { useRef } from "react";
import { useNavigate } from "react-router";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useTranslation } from "@/i18n";
import { NotificationToast } from "@/domains/home/components/notification-toast";
import type { FeedItemBucket } from "@vellumai/assistant-api";
import { toast } from "@vellumai/design-library/components/toast";

/**
 * How long a toast stays up.
 *
 * A guess, and flagged as one: five seconds is long enough to read two lines
 * and reach for the card, short enough that a burst does not queue behind
 * itself. Worth instrumenting before it is treated as settled.
 */
const TOAST_DURATION_MS = 5_000;

/**
 * Window inside which arrivals collapse into one summary toast, and the count
 * that triggers it.
 *
 * Below the threshold each toast is more useful on its own: two named outcomes
 * say more than "2 runs finished" does.
 */
const COLLAPSE_WINDOW_MS = 4_000;
const COLLAPSE_THRESHOLD = 3;

/** Stable id for the collapsed toast, so each new arrival replaces it. */
const COLLAPSED_TOAST_ID = "feed-toast-collapsed";

export function useFeedToastSync(): void {
  const navigate = useNavigate();
  const { t } = useTranslation("home");

  // Arrival times inside the collapse window, and the ids of the toasts drawn
  // for them, so a burst can retract the individual cards it already showed
  // and replace them with the summary.
  const recentRef = useRef<{ atMs: number; toastId: string | number }[]>([]);

  useBusSubscription("sse.event", (envelope) => {
    const event = envelope.message;
    if (event.type !== "feed_toast") {
      return;
    }

    // In-app only. `document.hasFocus()` is the narrow question the rule
    // actually asks: not "is the tab visible" (a visible background window
    // still wants the OS banner) but "is this window the one being used".
    if (typeof document !== "undefined" && !document.hasFocus()) {
      return;
    }

    const nowMs = Date.now();
    const recent = recentRef.current.filter(
      (entry) => nowMs - entry.atMs < COLLAPSE_WINDOW_MS,
    );

    const openFeedItem = () => {
      if (event.conversationId) {
        navigate(`/assistant/conversations/${event.conversationId}`);
        return;
      }
      navigate("/activity", { state: { feedItemId: event.feedItemId } });
    };

    if (recent.length + 1 >= COLLAPSE_THRESHOLD) {
      // Retract the cards already on screen for this burst: leaving them up
      // beside the summary would show the same work twice.
      for (const entry of recent) {
        toast.dismiss(entry.toastId);
      }
      const count = recent.length + 1;
      toast.custom(
        () => (
          <NotificationToast
            bucket="worth_knowing"
            title={t("feedToast.collapsedTitle", { total: count })}
            body={t("feedToast.collapsedBody")}
            onOpen={() => {
              toast.dismiss(COLLAPSED_TOAST_ID);
              navigate("/activity");
            }}
            onDismiss={() => toast.dismiss(COLLAPSED_TOAST_ID)}
          />
        ),
        { id: COLLAPSED_TOAST_ID, duration: TOAST_DURATION_MS },
      );
      // The summary stands for every arrival in the window, so the window
      // starts again rather than growing without bound.
      recentRef.current = [{ atMs: nowMs, toastId: COLLAPSED_TOAST_ID }];
      return;
    }

    const bucket: FeedItemBucket = event.bucket;
    const toastId = `feed-toast-${event.feedItemId}`;
    toast.custom(
      () => (
        <NotificationToast
          bucket={bucket}
          title={event.title}
          body={event.body}
          {...(event.actionLabel && event.actionPath
            ? {
                actionLabel: event.actionLabel,
                onAction: () => {
                  toast.dismiss(toastId);
                  navigate(event.actionPath!);
                },
              }
            : {})}
          onOpen={() => {
            toast.dismiss(toastId);
            openFeedItem();
          }}
          onDismiss={() => toast.dismiss(toastId)}
        />
      ),
      {
        id: toastId,
        // A needs-you toast waits: it is the one kind whose whole point is
        // that something is blocked until the reader answers.
        duration: bucket === "needs_you" ? Infinity : TOAST_DURATION_MS,
      },
    );

    recentRef.current = [...recent, { atMs: nowMs, toastId }];
  });
}
