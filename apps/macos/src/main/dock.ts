import { app, BrowserWindow, ipcMain } from "electron";

/**
 * Dock integration: unread-count badge + visibility state machine.
 *
 * Mirrors what the Swift app does today (`AppDelegate+WindowsAndSurfaces.swift`
 * → `NSApp.dockTile.badgeLabel`, `NSApplication.ActivationPolicy.regular`
 * ⇄ `.accessory`) so users see no regression when they cut over to
 * Electron.
 *
 * The state machine has two inputs:
 *
 *   1. **Visible window count**, observed via the `browser-window-created`
 *      / per-window `closed` events. No renderer involvement.
 *   2. **Signed-in flag**, published by the renderer over the
 *      `vellum:dock:setSignedIn` IPC channel. Renderer is the source of
 *      truth today; this side of the bridge becomes a no-op once the
 *      main-process auth state is the canonical signal.
 *
 * Policy:
 *
 *   - Any visible window OR signed in → `regular` (Dock icon visible).
 *     We keep the icon visible while signed in so the user can re-open
 *     the window from the Dock after closing the last one.
 *   - No visible window AND signed out → `accessory` (Dock icon hidden,
 *     menu-bar-only).
 *
 * Transitions are debounced ~100ms so a fast close-then-open (e.g.
 * keyboard shortcut chord) doesn't visibly flash the Dock icon.
 */

// Format the badge string per macOS Dock conventions: "" clears,
// "1"–"99" pass through, anything beyond becomes "99+" (the Slack-style
// truncation Swift Vellum already uses — `\"99+\"` shows up at
// `clients/macos/.../AppDelegate+WindowsAndSurfaces.swift:660-691`).
//
// `> 999 → "999+"` is what we'd want if we ever exposed a triple-digit
// counter, but macOS truncates very long strings and Swift caps at 99
// today; we match Swift.
export const formatBadge = (count: number): string => {
  if (!Number.isFinite(count) || count <= 0) return "";
  if (count > 99) return "99+";
  return String(Math.floor(count));
};

const POLICY_DEBOUNCE_MS = 100;

// Gate the `accessory` (menu-bar-only) transition until a menu-bar
// (tray) entry point exists. Going accessory before then would hide
// the Dock icon with no replacement, leaving the user no way to re-open
// the window. Flip to `true` in the same change that lands the tray.
const ALLOW_ACCESSORY_MODE = false;

interface DockState {
  signedIn: boolean;
  badgeCount: number;
  policy: "regular" | "accessory";
}

const state: DockState = {
  signedIn: false,
  badgeCount: 0,
  policy: "regular",
};

let refreshTimer: NodeJS.Timeout | null = null;

const visibleWindowCount = (): number =>
  BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).length;

// Pure function of (visible window count, signed-in flag, accessory-mode
// gate). Factored out of the caller so tests can exercise the matrix
// without standing up a full Electron `BrowserWindow` registry — the
// caller passes `visibleWindowCount()` + `state.signedIn` +
// `ALLOW_ACCESSORY_MODE` at the seam.
export const computePolicy = (
  visibleWindows: number,
  signedIn: boolean,
  allowAccessoryMode: boolean,
): DockState["policy"] => {
  if (visibleWindows > 0) return "regular";
  if (signedIn) return "regular";
  return allowAccessoryMode ? "accessory" : "regular";
};

// `app.dock.show()` returns a Promise that resolves once the Dock has
// reflected the change; `setActivationPolicy("regular")` after it
// keeps the two surfaces in sync (await sequencing is the documented
// pattern). The accessory transition is synchronous on the Electron
// side — `hide()` returns void — so no await there.
const applyPolicy = async (next: DockState["policy"]): Promise<void> => {
  if (next === state.policy) return;
  state.policy = next;
  if (!app.dock) return;
  if (next === "regular") {
    await app.dock.show();
    app.setActivationPolicy("regular");
  } else {
    app.dock.hide();
    app.setActivationPolicy("accessory");
  }
};

const scheduleRefresh = (): void => {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void applyPolicy(
      computePolicy(visibleWindowCount(), state.signedIn, ALLOW_ACCESSORY_MODE),
    );
  }, POLICY_DEBOUNCE_MS);
};

const applyBadge = (): void => {
  if (!app.dock) return;
  app.dock.setBadge(formatBadge(state.badgeCount));
};

/**
 * Wire the dock state machine. Call once from `whenReady`. Idempotent
 * — repeated calls are no-ops, so it's safe under hot-reload of the
 * main bundle in dev.
 */
let installed = false;
export const installDock = (): void => {
  if (installed) return;
  installed = true;

  // Renderer publishes the unread count whenever it changes. Coerce to
  // a finite non-negative integer so a renderer bug can't crash main.
  ipcMain.handle("vellum:dock:setBadge", (_event, count: unknown) => {
    const n = typeof count === "number" && Number.isFinite(count) ? count : 0;
    state.badgeCount = Math.max(0, Math.floor(n));
    applyBadge();
  });

  // Renderer-published signed-in flag. Becomes redundant once main
  // owns the auth state directly — at that point the source of truth
  // flips and this handler can be replaced with a subscription.
  //
  // On a flip to signed-out we also clear the badge synchronously
  // (here, ahead of the debounced policy refresh). Otherwise a logout
  // that destroys the renderer's JS context (hard navigate) can leave
  // a stale count on the Dock — the renderer never gets to publish
  // `setDockBadge(0)` because the layout unmounts first.
  ipcMain.handle("vellum:dock:setSignedIn", (_event, signedIn: unknown) => {
    const next = Boolean(signedIn);
    if (state.signedIn && !next) {
      state.badgeCount = 0;
      applyBadge();
    }
    state.signedIn = next;
    scheduleRefresh();
  });

  // Observe the visible-window count so closing the last window can
  // transition us into accessory mode (once `ALLOW_ACCESSORY_MODE` is
  // flipped), and opening the first one transitions us back to regular.
  app.on("browser-window-created", (_event, win) => {
    scheduleRefresh();
    win.once("closed", scheduleRefresh);
  });

  // macOS convention: clear the Dock badge before the process exits so
  // a relaunch doesn't briefly show a stale count from the OS's cache.
  app.on("before-quit", () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (app.dock) app.dock.setBadge("");
  });

  // Apply the initial policy + (empty) badge so we don't briefly show
  // the wrong state before the first event fires. The policy update is
  // fire-and-forget — its `dock.show()` Promise just sequences the
  // following `setActivationPolicy` call inside `applyPolicy`; the
  // caller has nothing to await on.
  void applyPolicy(
    computePolicy(visibleWindowCount(), state.signedIn, ALLOW_ACCESSORY_MODE),
  );
  applyBadge();
};
