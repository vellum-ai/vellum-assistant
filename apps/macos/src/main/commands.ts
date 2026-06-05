import { BrowserWindow } from "electron";

import { readSetting } from "./settings";

/**
 * Discriminated union of every command the app supports. Main is the source
 * of truth for the contract; the renderer-side mirror lives in
 * `apps/web/src/runtime/vellum-commands.ts`. Adding a variant here requires
 * a matching update there — both halves are tiny on purpose so divergence
 * is easy to spot in review.
 */
export type VellumCommand =
  | { kind: "newConversation" }
  | { kind: "currentConversation" }
  | { kind: "markCurrentUnread" }
  | { kind: "openSettings" }
  | { kind: "shareFeedback" }
  | { kind: "logout" };

export type VellumCommandKind = VellumCommand["kind"];

/**
 * Default accelerators per command, matching the Swift app's
 * `UserDefaults` defaults from
 * `clients/macos/vellum-assistant/App/AppDelegate+MenuBar.swift`.
 *
 * Populated lazily at menu-build time by merging with `settings.hotkeys`
 * (rather than via the electron-store schema `default` block, which would
 * clobber user overrides on schema migration).
 */
export const DEFAULT_ACCELERATORS: Record<VellumCommandKind, string> = {
  newConversation: "CmdOrCtrl+N",
  currentConversation: "CmdOrCtrl+Shift+N",
  markCurrentUnread: "CmdOrCtrl+Shift+U",
  openSettings: "CmdOrCtrl+,",
  shareFeedback: "",
  logout: "",
};

/**
 * Resolve the accelerator for a command, preferring the user override from
 * `settings.hotkeys.<kind>` and falling back to the default. Returns the
 * default for empty/non-string overrides so a corrupted setting doesn't
 * silently disable a menu item.
 */
export const resolveAccelerator = (kind: VellumCommandKind): string => {
  const hotkeys = readSetting("hotkeys");
  if (hotkeys && typeof hotkeys === "object") {
    const override = (hotkeys as Record<string, unknown>)[kind];
    if (typeof override === "string" && override.length > 0) {
      return override;
    }
  }
  return DEFAULT_ACCELERATORS[kind];
};

/**
 * Send a command to whichever BrowserWindow currently has focus, falling
 * back to the first window if none is focused (which happens when a menu
 * item is clicked from the menu bar while the app is in the background but
 * its window isn't the OS focus owner). Capturing a window reference at
 * menu-construction time would break future thread pop-outs, where the
 * user expects Cmd+N to operate on the popped-out window they're in.
 */
export const dispatchToFocused = (command: VellumCommand): void => {
  const target =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  target?.webContents.send("vellum:command", command);
};
