/**
 * Device-scoped chat composer preferences.
 *
 * `cmdEnterToSend` mirrors the macOS app's "Send with Cmd+Enter" setting
 * (`SettingsStore.cmdEnterToSend`): when enabled, Enter inserts a newline
 * in the composer and Cmd+Enter (Ctrl+Enter on Windows/Linux) sends the
 * message. Device-scoped so it describes this machine's keyboard habits
 * and survives logout, matching the native app's UserDefaults semantics.
 */

import { createStorageAccessor, parseBool } from "@/utils/typed-storage";

export const cmdEnterToSend = createStorageAccessor<boolean>({
  key: "device:cmd_enter_to_send",
  scope: "device",
  parse: parseBool,
  serialize: String,
  fallback: false,
});

/**
 * Opt-in for the composer's context-window fill ring. Off by default: the
 * assistant compacts its own context, so a gauge climbing toward "full"
 * reads as an impending failure the user is expected to manage. `/status`
 * reports the same numbers on demand for anyone who wants them.
 */
export const showContextWindowIndicator = createStorageAccessor<boolean>({
  key: "device:show_context_window_indicator",
  scope: "device",
  parse: parseBool,
  serialize: String,
  fallback: false,
});
