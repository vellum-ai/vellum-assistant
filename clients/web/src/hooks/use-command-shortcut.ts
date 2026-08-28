import { formatAcceleratorHint } from "@vellumai/design-library";
import { DEFAULT_ACCELERATORS } from "@vellumai/ipc-contract";
import { useSyncExternalStore } from "react";

import { isElectron } from "@/runtime/is-electron";
import {
  getHotkeys,
  onHotkeysChange,
  type ResolvedHotkey,
} from "@/runtime/hotkeys";

/**
 * What a command's keyboard shortcut is on the host this renderer is running
 * in, for surfaces that want to show it (menu rows, the command palette,
 * tooltips).
 *
 * Two hosts answer differently and a caller should not have to know which one
 * it is in. On the desktop the answer is the Electron catalog, which is
 * authoritative because the user can rebind it. In a browser most of these
 * commands are not bound at all, and the handful the web app binds itself have
 * their own chords: `Cmd+N` would open a browser window, so new chat is
 * `Cmd+Shift+O` there. A surface that hardcoded the desktop accelerator would
 * advertise a shortcut that does nothing.
 *
 * An unbound command resolves to `undefined` rather than an empty string, so
 * the absence of a shortcut is a value a caller can render nothing for.
 */

/**
 * Commands whose shortcut this module can answer for: the Electron catalog
 * (rebindable commands plus the reserved ones the app binds without exposing)
 * and the chords the web app registers itself.
 */
export type CommandShortcutKey =
  | "commandPalette"
  | "currentConversation"
  | "find"
  | "globalHotkey"
  | "home"
  | "markCurrentUnread"
  | "navigateBack"
  | "navigateForward"
  | "newConversation"
  | "nextConversation"
  | "openSettings"
  | "popOut"
  | "previousConversation"
  | "quickInput"
  | "sidebarToggle"
  | "togglePinConversation"
  | "toggleVoice";

/**
 * Chords the web app binds for itself, registered by `useChatLayoutShortcuts`.
 * Anything absent here is desktop-only and has no shortcut in a browser, which
 * is the common case: pinning, marking unread, and popping out are all menu
 * commands the web build never binds.
 *
 * Exported so the handler's own test can drive itself from this table: a hint
 * naming a chord the handler does not answer is the failure mode, and nothing
 * in the types connects the two.
 */
export const WEB_ACCELERATORS: Partial<Record<CommandShortcutKey, string>> = {
  newConversation: "CmdOrCtrl+Shift+O",
  sidebarToggle: "CmdOrCtrl+\\",
  commandPalette: "CmdOrCtrl+K",
  navigateBack: "CmdOrCtrl+[",
  navigateForward: "CmdOrCtrl+]",
};

/**
 * The shell's compiled menu accelerators, widened to this module's keys.
 *
 * The global-scope commands (`globalHotkey`, `quickInput`, `toggleVoice`) are
 * registered as system shortcuts rather than menu items and so are absent
 * here; they resolve only once the catalog arrives, which is correct, since
 * there is no compiled menu binding to claim on their behalf.
 */
const DESKTOP_MENU_DEFAULTS: Partial<Record<CommandShortcutKey, string>> =
  DEFAULT_ACCELERATORS;

/**
 * The Electron catalog, cached for the lifetime of the renderer.
 *
 * Held at module scope rather than per hook so that every row of a menu reads
 * one already-resolved answer: fetching per consumer would open a menu with no
 * hints and fill them in a frame later. The catalog arrives once and is kept
 * current by the main process, which broadcasts on every rebind, so there is
 * nothing to poll and nothing to invalidate.
 */
let catalog: ResolvedHotkey[] = [];
let revision = 0;
const listeners = new Set<() => void>();

function publish(next: ResolvedHotkey[]): void {
  catalog = next;
  revision += 1;
  for (const listener of listeners) {
    listener();
  }
}

/**
 * The main process broadcasts for as long as the renderer lives, so this
 * subscription is never torn down. It is one listener for the whole app rather
 * than one per consumer, so it does not grow.
 */
let started = false;

function ensureLoaded(): void {
  if (started || !isElectron()) {
    return;
  }
  started = true;
  void getHotkeys().then(publish);
  onHotkeysChange(publish);
}

function subscribe(listener: () => void): () => void {
  ensureLoaded();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getRevision(): number {
  return revision;
}

/**
 * The accelerator bound to a command on this host, or `undefined` when it has
 * none. Readable outside React (the command palette builds its items in a
 * plain function); components should prefer {@link useCommandShortcut}, which
 * re-renders when the user rebinds.
 */
export function commandAccelerator(
  key: CommandShortcutKey,
): string | undefined {
  if (!isElectron()) {
    return WEB_ACCELERATORS[key];
  }
  // A caller outside React reaches the catalog before any component has
  // subscribed, so asking is what starts it loading.
  ensureLoaded();
  if (catalog.length === 0) {
    // No catalog yet, either because it has not arrived or because the shell
    // is too old to report one. Either way the shell registered the compiled
    // defaults, so those are the truthful answer until it says otherwise.
    return DESKTOP_MENU_DEFAULTS[key] || undefined;
  }
  const entry = catalog.find((hotkey) => hotkey.key === key);
  // An empty accelerator is how the catalog spells "bound to nothing".
  return entry?.accelerator ? entry.accelerator : undefined;
}

/**
 * Bumps whenever the catalog changes. A caller that computes hints inside a
 * `useMemo` lists this as a dependency, so they refresh when the catalog
 * arrives and when the user rebinds.
 */
export function useCommandShortcutsRevision(): number {
  return useSyncExternalStore(subscribe, getRevision, getRevision);
}

/**
 * The accelerator bound to a command on this host, tracking rebinds.
 *
 * Returns a string rather than an object so a caller can use it directly as a
 * dependency and so there is no per-render identity to memoize.
 */
export function useCommandShortcut(
  key: CommandShortcutKey,
): string | undefined {
  useCommandShortcutsRevision();
  return commandAccelerator(key);
}

/**
 * The compact glyph form of a command's shortcut (`⇧⌘O`, `Ctrl+Shift+O`), or
 * `undefined` when it has none. For surfaces that render a hint as text; a
 * menu row takes the accelerator itself and draws it.
 */
export function useCommandShortcutHint(
  key: CommandShortcutKey,
): string | undefined {
  const accelerator = useCommandShortcut(key);
  return accelerator ? formatAcceleratorHint(accelerator) : undefined;
}

/**
 * Reset the module cache. Test seam, named with the `__…ForTesting` prefix
 * the app uses to mark one; not part of the runtime contract.
 */
export function __resetCommandShortcutsForTesting(): void {
  catalog = [];
  revision = 0;
  started = false;
  listeners.clear();
}
