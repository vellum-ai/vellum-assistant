import { BrowserWindow } from "electron";

import type { VellumCommand } from "@vellumai/ipc-contract";

import { readHotkeyOverride } from "./settings";

export type { VellumCommand };

export type VellumCommandKind = VellumCommand["kind"];

/**
 * Default accelerators per command.
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
  find: "CmdOrCtrl+F",
  markAllRead: "",
  login: "",
  logout: "",
  rePair: "",
  sidebarToggle: "CmdOrCtrl+\\",
  home: "CmdOrCtrl+Shift+H",
  popOut: "CmdOrCtrl+P",
  previousConversation: "CmdOrCtrl+Up",
  nextConversation: "CmdOrCtrl+Down",
  commandPalette: "CmdOrCtrl+K",
  openConversation: "",
  openLibrary: "",
  openIdentity: "",
  navigateBack: "",
  navigateForward: "",
  zoomIn: "",
  zoomOut: "",
  actualSize: "",
  selectAssistant: "",
  chooseAssistant: "",
  createAssistant: "",
  retireAssistant: "",
  quickInputSubmit: "",
  cancelDictation: "",
  replayOnboarding: "",
  previewPrechat: "",
  replayHatchFailure: "",
  openComponentGallery: "",
};

/**
 * Commands whose accelerators are registered as Electron `globalShortcut`s
 * (system-wide, active even when the app is not focused). Every other
 * command uses menu accelerators which only fire when the app has focus.
 */
export const GLOBAL_SHORTCUT_DEFAULTS: Record<string, string> = {
  globalHotkey: "CmdOrCtrl+Shift+G",
  quickInput: "CmdOrCtrl+Shift+/",
};

/**
 * Resolve the accelerator for a command, preferring the user override from
 * `settings.hotkeys.<kind>` and falling back to the compiled default when no
 * override is set. An explicit empty-string override is honored as "disabled"
 * (the user removed the binding via the Keyboard Shortcuts settings) — callers
 * that build menu items must treat an empty result as "no accelerator".
 */
export const resolveAccelerator = (kind: VellumCommandKind): string => {
  return readHotkeyOverride(kind) ?? DEFAULT_ACCELERATORS[kind];
};

/**
 * Menu/tray template fragment carrying a command's accelerator, or no
 * `accelerator` key at all when the binding is disabled (an empty-string
 * override, or a command with no compiled default). Electron treats a missing
 * `accelerator` as "no shortcut", whereas `accelerator: ""` is not a valid
 * accelerator — passing it to `Menu.buildFromTemplate` throws. Every menu and
 * tray item builds its accelerator through this helper so the empty-string
 * case is handled in exactly one place.
 */
export const acceleratorOption = (
  kind: VellumCommandKind,
): { accelerator?: string } => {
  const accelerator = resolveAccelerator(kind);
  return accelerator ? { accelerator } : {};
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
