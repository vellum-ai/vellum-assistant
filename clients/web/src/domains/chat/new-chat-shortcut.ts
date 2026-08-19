import { parseAccelerator } from "@vellumai/design-library";

import { isElectron } from "@/runtime/is-electron";

/**
 * Electron File menu accelerator for New Chat (`DEFAULT_ACCELERATORS.newConversation`).
 * The native macOS/Windows app binds this as a menu shortcut.
 */
export const ELECTRON_NEW_CHAT_ACCELERATOR = "CmdOrCtrl+N";

/**
 * In-app web shortcut registered by `useChatLayoutShortcuts` (the ChatGPT /
 * Claude convention). Used when the renderer is not inside Electron, where
 * Cmd/Ctrl+N would create a browser window instead.
 */
export const WEB_NEW_CHAT_ACCELERATOR = "CmdOrCtrl+Shift+O";

/** Electron accelerator string for the host this renderer is running in. */
export function newChatAccelerator(): string {
  return isElectron()
    ? ELECTRON_NEW_CHAT_ACCELERATOR
    : WEB_NEW_CHAT_ACCELERATOR;
}

/** Compact glyph form for tooltips and palette hints (`⌘N`, `⌘⇧O`). */
export function newChatShortcutHint(): string {
  return parseAccelerator(newChatAccelerator()).join("");
}
