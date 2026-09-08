/**
 * COOP-aware observation of an OAuth popup.
 *
 * A popup that navigates to a document carrying `Cross-Origin-Opener-Policy`
 * is moved into a fresh browsing-context group and the opener's handle is
 * disowned. From that moment `popup.closed` reads `true` forever and
 * `popup.close()` is a no-op, while the window is still on screen and the user
 * is still working through the flow. `link.com` sends `same-origin` and
 * `connect.stripe.com` sends `same-origin-allow-popups`; both sever. Google
 * sends the report-only variant today and will sever the day it enforces.
 *
 * A disowned handle is indistinguishable from a closed one: the spec defines
 * `closed` as "browsing context is null", which both satisfy. So this watcher
 * does not guess. It reports *when* observation was lost relative to the
 * provider hand-off, which is the part we control:
 *
 * - Before the hand-off the popup is still our own `about:blank`, so no COOP
 *   response can have applied and `closed` really does mean the user closed it.
 * - After the hand-off the signal is ambiguous. Treating it as a cancellation
 *   is what surfaced "authorization popup closed" while the Link login was
 *   still open and mid-flow.
 */

/** The popup surface this module observes. Structural, so tests can stub it. */
export interface ObservablePopup {
  readonly closed: boolean;
  close: () => void;
}

export type PopupLostReason =
  /** Closed while we still owned the handle. A real cancellation. */
  | "closed"
  /** Went dark after the hand-off. Either a close or a COOP disown. */
  | "unobservable";

export const POPUP_POLL_INTERVAL_MS = 100;

/**
 * Settle time before acting on a lost handle, so a completion that arrives
 * through `postMessage` or `storage` as the popup tears itself down wins over
 * the fallback path.
 */
export const POPUP_LOST_GRACE_MS = 1000;

/**
 * How long the completion channels stay armed once a popup goes unobservable.
 * A provider flow with an SMS or authenticator step routinely runs past a
 * minute, and that is exactly the flow whose popup we can no longer see.
 */
export const UNOBSERVABLE_COMPLETION_WINDOW_MS = 3 * 60_000;

export interface WatchOAuthPopupOptions {
  popup: ObservablePopup;
  /** Fires at most once, after the grace period. */
  onLost: (reason: PopupLostReason) => void;
  pollIntervalMs?: number;
  graceMs?: number;
}

export interface OAuthPopupWatch {
  /** Call once the popup has been pointed at the provider's connect URL. */
  markHandedToProvider: () => void;
  stop: () => void;
}

export function watchOAuthPopup({
  popup,
  onLost,
  pollIntervalMs = POPUP_POLL_INTERVAL_MS,
  graceMs = POPUP_LOST_GRACE_MS,
}: WatchOAuthPopupOptions): OAuthPopupWatch {
  let handedToProvider = false;
  let graceTimeout: ReturnType<typeof setTimeout> | null = null;

  let interval: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (!popup.closed || graceTimeout) {
      return;
    }
    const reason: PopupLostReason = handedToProvider
      ? "unobservable"
      : "closed";
    graceTimeout = setTimeout(() => {
      graceTimeout = null;
      stop();
      onLost(reason);
    }, graceMs);
  }, pollIntervalMs);

  function stop(): void {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    if (graceTimeout) {
      clearTimeout(graceTimeout);
      graceTimeout = null;
    }
  }

  return {
    markHandedToProvider: () => {
      handedToProvider = true;
    },
    stop,
  };
}

/**
 * Close a popup we still own. Best effort by construction: a disowned handle
 * reports `closed` and ignores `close()`, so the window it leaves on screen is
 * the provider's to close.
 */
export function closeOAuthPopup(popup: ObservablePopup | null): void {
  if (popup && !popup.closed) {
    popup.close();
  }
}
