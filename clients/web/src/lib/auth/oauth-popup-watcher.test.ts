/**
 * The watcher's whole job is to refuse to call a disowned popup "closed".
 *
 * `link.com` (COOP `same-origin`) and `connect.stripe.com` (COOP
 * `same-origin-allow-popups`) both move the popup into a new
 * browsing-context group, after which `popup.closed` reads `true` forever
 * while the window is still open and mid-flow. These tests pin the one thing
 * that distinguishes the two cases: whether the popup had been handed to the
 * provider yet.
 */

import { describe, expect, test } from "bun:test";

import {
  closeOAuthPopup,
  watchOAuthPopup,
  type ObservablePopup,
  type PopupLostReason,
} from "./oauth-popup-watcher";

const POLL_MS = 5;
const GRACE_MS = 10;

/** A popup whose handle behaves like a real one: `close()` marks it closed. */
function realPopup() {
  const popup = {
    closed: false,
    closeCalls: 0,
    close() {
      popup.closeCalls += 1;
      popup.closed = true;
    },
  };
  return popup;
}

/**
 * A COOP-disowned handle: reports closed while the window is still open, and
 * ignores `close()` entirely.
 */
function disownedPopup() {
  return {
    closed: true,
    closeCalls: 0,
    close() {
      this.closeCalls += 1;
    },
  };
}

function watchUntilLost(popup: ObservablePopup, handOff: boolean) {
  return new Promise<PopupLostReason>((resolve) => {
    const watch = watchOAuthPopup({
      popup,
      onLost: resolve,
      pollIntervalMs: POLL_MS,
      graceMs: GRACE_MS,
    });
    if (handOff) {
      watch.markHandedToProvider();
    }
  });
}

describe("watchOAuthPopup", () => {
  test("a popup closed before the hand-off is a real cancellation", async () => {
    const popup = realPopup();
    const lost = watchUntilLost(popup, false);
    popup.closed = true;
    expect(await lost).toBe("closed");
  });

  test("a popup that goes dark after the hand-off is only 'unobservable'", async () => {
    const popup = realPopup();
    const lost = watchUntilLost(popup, true);
    // What COOP does to the handle: reads closed while the window is open.
    popup.closed = true;
    expect(await lost).toBe("unobservable");
  });

  test("onLost fires once, not once per poll tick", async () => {
    const popup = realPopup();
    let calls = 0;
    const watch = watchOAuthPopup({
      popup,
      onLost: () => {
        calls += 1;
      },
      pollIntervalMs: POLL_MS,
      graceMs: GRACE_MS,
    });
    popup.closed = true;
    await new Promise((r) => setTimeout(r, POLL_MS * 12 + GRACE_MS));
    watch.stop();
    expect(calls).toBe(1);
  });

  test("stop() before the grace elapses cancels the report", async () => {
    const popup = realPopup();
    let calls = 0;
    const watch = watchOAuthPopup({
      popup,
      onLost: () => {
        calls += 1;
      },
      pollIntervalMs: POLL_MS,
      graceMs: GRACE_MS * 20,
    });
    popup.closed = true;
    await new Promise((r) => setTimeout(r, POLL_MS * 3));
    watch.stop();
    await new Promise((r) => setTimeout(r, GRACE_MS * 25));
    expect(calls).toBe(0);
  });

  test("an open popup is never reported lost", async () => {
    const popup = realPopup();
    let calls = 0;
    const watch = watchOAuthPopup({
      popup,
      onLost: () => {
        calls += 1;
      },
      pollIntervalMs: POLL_MS,
      graceMs: GRACE_MS,
    });
    await new Promise((r) => setTimeout(r, POLL_MS * 8 + GRACE_MS));
    watch.stop();
    expect(calls).toBe(0);
  });
});

describe("closeOAuthPopup", () => {
  test("closes a popup we still own", () => {
    const popup = realPopup();
    closeOAuthPopup(popup);
    expect(popup.closeCalls).toBe(1);
    expect(popup.closed).toBe(true);
  });

  test("does not call close() on a disowned handle", () => {
    // `close()` is a no-op across a severed browsing-context group, so calling
    // it would only invite callers to believe the window went away.
    const popup = disownedPopup();
    closeOAuthPopup(popup);
    expect(popup.closeCalls).toBe(0);
  });

  test("tolerates a null popup (the native path never opens one)", () => {
    expect(() => closeOAuthPopup(null)).not.toThrow();
  });
});
