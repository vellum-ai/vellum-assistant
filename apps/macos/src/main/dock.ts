import path from "node:path";

import { app, nativeImage, type NativeImage } from "electron";
import { z } from "zod";

import { onAvatarChange } from "./avatar";
import { avatarBitmap } from "./avatar-image";
import { applyAlphaMask, compositeCentered, roundedRectCoverage } from "./image-mask";
import { on } from "./ipc";
import {
  current as currentMainWindow,
  onMainWindowVisibilityChange,
} from "./main-window";

/**
 * Dock integration: avatar icon + unread-count badge + visibility state
 * machine.
 *
 * Mirrors what the Swift app does today (`AppDelegate+WindowsAndSurfaces.swift`
 * → `NSApp.dockTile.badgeLabel`, `NSApplication.ActivationPolicy.regular`
 * ⇄ `.accessory`, and `AvatarAppearanceManager` →
 * `NSApplication.applicationIconImage`) so users see no regression when they
 * cut over to Electron.
 *
 * The Dock icon is the assistant avatar clipped to a rounded square
 * ("squircle"), inset with ~10% padding inside a 512px canvas to match the
 * macOS icon grid. The renderer publishes the avatar over
 * `vellum:icon:setAvatar`; this module masks and applies it via
 * `app.dock.setIcon`. With no avatar the bundled app icon shows through
 * naturally, exactly as the native app falls back to its bundled mark.
 *
 * The Dock tile is the only icon surface Electron exposes directly;
 * LaunchServices-resolved surfaces (Finder, the notification daemon) read
 * the on-disk bundle icon, which would need a native `NSWorkspace.setIcon`
 * bridge to mirror — out of scope here and tracked separately.
 *
 * The state machine has two inputs:
 *
 *   1. **Main-window visibility**, subscribed via
 *      `onMainWindowVisibilityChange` on `./main-window`. Auxiliary
 *      windows (About, future thread pop-outs) deliberately do NOT
 *      drive dock policy — opening About while signed out would
 *      otherwise flicker the dock icon to `regular` and back.
 *   2. **Signed-in flag**, published by the renderer over the
 *      `vellum:dock:setSignedIn` IPC channel. Renderer is the source of
 *      truth today; this side of the bridge becomes a no-op once the
 *      main-process auth state is the canonical signal.
 *
 * Policy:
 *
 *   - Main visible OR signed in → `regular` (Dock icon visible).
 *     We keep the icon visible while signed in so the user can re-open
 *     the window from the Dock after closing the last one.
 *   - Main hidden AND signed out → `accessory` (Dock icon hidden,
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

// When the user is signed out and no windows are visible, drop the
// Dock icon and run menu-bar-only — same accessory-mode UX Swift Vellum
// exposes. Safe to flip on now that `installTray` provides an
// always-available entry point back to the app (the Dock icon used to
// be the only one). Kept as a module-level constant rather than a
// setting so the build-time choice is reviewable.
const ALLOW_ACCESSORY_MODE = true;

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

// True iff the main window is the visible, focusable surface. The dock
// policy is conceptually about the main window — not about "any window
// being alive" — so we check by reference via `main-window.current()`
// rather than scanning every BrowserWindow. Auxiliary windows
// (About, future thread pop-outs, command palette) should NOT keep
// the dock icon visible when the user is signed out — that would be
// a UX bug: opening About would briefly show the dock icon and
// closing it would hide it again.
const isMainWindowVisible = (): boolean => {
  const win = currentMainWindow();
  return !!win && !win.isDestroyed() && win.isVisible();
};

// Pure function of (main-window visibility, signed-in flag,
// accessory-mode gate). Factored out so tests can exercise the
// 2×2×2 matrix without standing up an Electron BrowserWindow.
// Caller passes `isMainWindowVisible()` + `state.signedIn` +
// `ALLOW_ACCESSORY_MODE` at the seam.
export const computePolicy = (
  mainVisible: boolean,
  signedIn: boolean,
  allowAccessoryMode: boolean,
): DockState["policy"] => {
  if (mainVisible) return "regular";
  if (signedIn) return "regular";
  return allowAccessoryMode ? "accessory" : "regular";
};

// `app.dock.show()` returns a Promise that resolves once the Dock has
// reflected the change; `setActivationPolicy("regular")` after it
// keeps the two surfaces in sync (await sequencing is the documented
// pattern). The accessory transition is synchronous on the Electron
// side — `hide()` returns void — so no await there.
//
// Re-check `state.policy` after the awaited `dock.show()`. Between
// the await and resume, another `applyPolicy("accessory")` may have
// run synchronously and flipped both the state and the activation
// policy. Without the re-check, the resuming `regular` call would
// stomp the newer `accessory` setActivationPolicy, leaving the
// activation policy and dock visibility out of sync.
const applyPolicy = async (next: DockState["policy"]): Promise<void> => {
  if (next === state.policy) return;
  state.policy = next;
  if (!app.dock) return;
  if (next === "regular") {
    await app.dock.show();
    // A concurrent `applyPolicy("accessory")` may have run while we
    // were awaiting — bail out so we don't override its
    // `setActivationPolicy("accessory")`.
    if (state.policy !== "regular") return;
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
      computePolicy(isMainWindowVisible(), state.signedIn, ALLOW_ACCESSORY_MODE),
    );
  }, POLICY_DEBOUNCE_MS);
};

const applyBadge = (): void => {
  if (!app.dock) return;
  app.dock.setBadge(formatBadge(state.badgeCount));
};

// Dock-icon geometry, matching the native app's `composeDockIcon`
// (`AvatarAppearanceManager.swift`): a 418px squircle inset inside a 512px
// canvas (~10% padding) so the artwork doesn't crowd the Dock
// running-indicator dot, with the squircle corner radius at 0.23× the icon
// size to match `NSBezierPath(roundedRect:xRadius:)`.
const DOCK_CANVAS_PX = 512;
const DOCK_ICON_PX = 418;
const DOCK_CORNER_RADIUS_RATIO = 0.23;

// Tracks whether we've applied an avatar-derived Dock icon. Drives the
// restore-to-bundle-icon path: we only override the bundled icon once an
// avatar exists, and only reset when a previously-set avatar is cleared.
let dockIconApplied = false;

// The per-environment bundled app icon, copied beside the app's resources by
// electron-builder (`extraResources: build/icon.icns → icon.icns`) and loaded
// lazily on first restore. `undefined` = not yet probed, `null` = absent
// (e.g. `bun run dev`, which runs against Electron's default icon).
let bundleIconCache: NativeImage | null | undefined;

// Electron exposes no "reset to bundle icon" for the Dock — `app.dock.setIcon`
// only sets an image, and `nativeImage.createEmpty()` blanks the tile rather
// than reverting. So we re-apply the bundled icon explicitly to mirror the
// native app's `applicationIconImage = nil` fallback. Resolving the real
// per-env `.icns` at runtime (rather than embedding one mark) keeps dev /
// staging / production icons correct.
const bundleIcon = (): NativeImage | null => {
  if (bundleIconCache !== undefined) return bundleIconCache;
  const base = process.resourcesPath;
  const icon = base
    ? nativeImage.createFromPath(path.join(base, "icon.icns"))
    : nativeImage.createEmpty();
  bundleIconCache = icon.isEmpty() ? null : icon;
  return bundleIconCache;
};

/**
 * Build the Dock icon from the cached avatar: clip to a squircle and inset
 * it inside a transparent 512px canvas. Returns `null` when no avatar is
 * available, so the caller can leave the bundled app icon in place.
 */
export const buildDockIcon = (): NativeImage | null => {
  const avatar = avatarBitmap(DOCK_ICON_PX);
  if (!avatar) return null;

  const masked = applyAlphaMask(
    avatar,
    DOCK_ICON_PX,
    roundedRectCoverage(DOCK_ICON_PX, DOCK_ICON_PX * DOCK_CORNER_RADIUS_RATIO),
  );
  const canvas = compositeCentered(masked, DOCK_ICON_PX, DOCK_CANVAS_PX);
  return nativeImage.createFromBitmap(canvas, {
    width: DOCK_CANVAS_PX,
    height: DOCK_CANVAS_PX,
  });
};

/**
 * Apply (or restore) the Dock icon for the current avatar.
 *
 *   - Avatar present → mask to a squircle and set it via `app.dock.setIcon`.
 *   - Avatar cleared after one was set → re-apply the bundled app icon (the
 *     native `applicationIconImage = nil` fallback). When the bundled icon
 *     isn't resolvable (dev), leave the last icon in place rather than
 *     blanking the Dock with an empty image.
 *   - No avatar and none ever set → leave the bundled icon untouched so the
 *     first paint shows it naturally, matching the native fallback.
 */
export const applyDockIcon = (): void => {
  if (!app.dock) return;

  const icon = buildDockIcon();
  if (icon) {
    app.dock.setIcon(icon);
    dockIconApplied = true;
    return;
  }
  if (!dockIconApplied) return;
  const bundle = bundleIcon();
  if (bundle) {
    app.dock.setIcon(bundle);
    dockIconApplied = false;
  }
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

  // Renderer publishes the unread count whenever it changes. The schema
  // guarantees a finite number (`z.number()` rejects NaN/Infinity), so
  // the only remaining clamp is to a non-negative integer for display.
  on("vellum:dock:setBadge", z.tuple([z.number()]), ([count]) => {
    state.badgeCount = Math.max(0, Math.floor(count));
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
  on("vellum:dock:setSignedIn", z.tuple([z.boolean()]), ([signedIn]) => {
    if (state.signedIn && !signedIn) {
      state.badgeCount = 0;
      applyBadge();
    }
    state.signedIn = signedIn;
    scheduleRefresh();
  });

  // Subscribe to main-window visibility transitions (created, shown,
  // hidden, closed). Auxiliary windows (About, future thread pop-outs,
  // command palette) don't fire this hook, so they correctly don't
  // affect dock policy — a signed-out user opening About would
  // otherwise briefly flicker the dock icon to `regular` and back.
  onMainWindowVisibilityChange(scheduleRefresh);

  // Re-render the Dock icon whenever the renderer publishes a new (or
  // cleared) avatar, mirroring the native app's `updateDockIcon`.
  onAvatarChange(applyDockIcon);

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
    computePolicy(isMainWindowVisible(), state.signedIn, ALLOW_ACCESSORY_MODE),
  );
  applyBadge();
};

// Test seam — resets the avatar-applied flag and the cached bundle icon so a
// test starts from the first-paint state (no icon ever set). Production code
// never calls this.
export const __resetForTesting = (): void => {
  dockIconApplied = false;
  bundleIconCache = undefined;
};
