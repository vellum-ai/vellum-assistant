import { BrowserWindow } from "electron";
import { z } from "zod";

import type { HotkeyScope, ResolvedHotkey } from "@vellumai/ipc-contract";

import { isValidAccelerator } from "./accelerator";
import {
  DEFAULT_ACCELERATORS,
  GLOBAL_SHORTCUT_DEFAULTS,
  type VellumCommandKind,
} from "./commands";
import { handle } from "./ipc";
import { onSettingChange, readHotkeyOverride, readSetting, writeSetting } from "./settings";

export type { HotkeyScope, ResolvedHotkey };

interface HotkeyCommand {
  /** Key into `settings.hotkeys` and the matching defaults map. */
  key: string;
  /** User-facing label, matching the native app's Keyboard Shortcuts card. */
  label: string;
  scope: HotkeyScope;
}

/**
 * The rebindable commands surfaced in the Keyboard Shortcuts settings, in the
 * same order and with the same labels as the native macOS app's
 * `SettingsAppearanceTab` "Keyboard Shortcuts" card. This is the parity
 * contract: commands the native card does not let the user rebind (voice
 * input, Find, Command Palette, Settings) are intentionally absent.
 */
const HOTKEY_CATALOG: readonly HotkeyCommand[] = [
  { key: "globalHotkey", label: "Open Vellum", scope: "global" },
  { key: "quickInput", label: "Quick Input", scope: "global" },
  { key: "newConversation", label: "New chat", scope: "menu" },
  { key: "currentConversation", label: "Current conversation", scope: "menu" },
  {
    key: "markCurrentUnread",
    label: "Mark conversation as unread",
    scope: "menu",
  },
  { key: "sidebarToggle", label: "Toggle sidebar", scope: "menu" },
  { key: "popOut", label: "Pop out conversation", scope: "menu" },
  { key: "home", label: "Home", scope: "menu" },
  { key: "previousConversation", label: "Previous conversation", scope: "menu" },
  { key: "nextConversation", label: "Next conversation", scope: "menu" },
];

const CATALOG_KEYS = new Set(HOTKEY_CATALOG.map((command) => command.key));

/**
 * Commands the app binds but does not expose for rebinding. Their accelerators
 * are still "taken", so the recorder must treat them as conflicts — otherwise a
 * user could bind a rebindable command to, say, Find's chord and silently break
 * one of the two menu items that would then share it. They are not in
 * `HOTKEY_CATALOG` (so they render no row and `writeHotkey` rejects writes to
 * them); they ride along in the resolved catalog flagged `rebindable: false`
 * purely so conflict detection sees the full set of bound accelerators. Labels
 * match the application menu so the conflict message names a command the user
 * recognizes.
 */
const RESERVED_COMMANDS: readonly HotkeyCommand[] = [
  { key: "find", label: "Find", scope: "menu" },
  { key: "openSettings", label: "Settings", scope: "menu" },
  { key: "commandPalette", label: "Command Palette", scope: "menu" },
];

const defaultAcceleratorFor = (command: HotkeyCommand): string =>
  command.scope === "global"
    ? (GLOBAL_SHORTCUT_DEFAULTS[command.key] ?? "")
    : (DEFAULT_ACCELERATORS[command.key as VellumCommandKind] ?? "");

const resolveCommand = (
  command: HotkeyCommand,
  rebindable: boolean,
): ResolvedHotkey => {
  const override = readHotkeyOverride(command.key);
  const defaultAccelerator = defaultAcceleratorFor(command);
  return {
    key: command.key,
    label: command.label,
    scope: command.scope,
    defaultAccelerator,
    override,
    accelerator: override ?? defaultAccelerator,
    rebindable,
  };
};

/**
 * The resolved catalog: every rebindable command followed by the reserved
 * commands whose accelerator is currently bound (a non-empty resolved value).
 * Disabled reserved bindings are dropped — an empty accelerator can never
 * conflict, so carrying it would only add noise.
 */
export const resolveHotkeyCatalog = (): ResolvedHotkey[] => [
  ...HOTKEY_CATALOG.map((command) => resolveCommand(command, true)),
  ...RESERVED_COMMANDS.map((command) => resolveCommand(command, false)).filter(
    (entry) => entry.accelerator !== "",
  ),
];

/**
 * Persist a single hotkey override. `null` clears the override (reverting to
 * the compiled default), `""` disables the binding, and any other value is a
 * custom accelerator that must pass Electron's grammar. Writing merges into the
 * existing map so other commands' overrides are preserved, and triggers the
 * `onSettingChange("hotkeys")` subscribers that re-register global shortcuts
 * and rebuild the menu.
 */
const writeHotkey = (key: string, accelerator: string | null): void => {
  if (!CATALOG_KEYS.has(key)) {
    throw new Error(`Unknown hotkey command: ${key}`);
  }
  if (
    accelerator !== null &&
    accelerator !== "" &&
    !isValidAccelerator(accelerator)
  ) {
    throw new Error(`Invalid accelerator: ${accelerator}`);
  }

  const next = { ...(readSetting("hotkeys") ?? {}) };
  if (accelerator === null) {
    delete next[key];
  } else {
    next[key] = accelerator;
  }
  writeSetting("hotkeys", next);
};

const broadcastCatalog = (): void => {
  const catalog = resolveHotkeyCatalog();
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("vellum:hotkeys:changed", catalog);
  }
};

let teardown: (() => void) | null = null;

/**
 * Install the typed Keyboard Shortcuts IPC surface: `get` returns the resolved
 * catalog, `set` validates and persists one override, and a `changed` event is
 * broadcast to every window whenever the hotkeys setting changes (including
 * changes a different window initiated) so open settings views stay in sync.
 */
export const installHotkeysIpc = (): void => {
  if (teardown) return;

  handle("vellum:hotkeys:get", z.tuple([]), () => resolveHotkeyCatalog());
  handle(
    "vellum:hotkeys:set",
    z.tuple([z.string(), z.union([z.string(), z.null()])]),
    ([key, accelerator]) => {
      writeHotkey(key, accelerator);
    },
  );

  teardown = onSettingChange("hotkeys", () => {
    broadcastCatalog();
  });
};

/**
 * Tear down the IPC subscription so a subsequent `installHotkeysIpc` re-runs
 * from a clean slate. Test-only; production installs once for the app's
 * lifetime.
 */
export const __resetForTesting = (): void => {
  teardown?.();
  teardown = null;
};
