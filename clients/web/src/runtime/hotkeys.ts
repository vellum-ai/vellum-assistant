import { isElectron, type ResolvedHotkey } from "@/runtime/is-electron";

/**
 * Runtime wrapper for the Electron Keyboard Shortcuts bridge
 * (`window.vellum.hotkeys`). This is the only place in the web app that
 * touches that bridge surface; the settings UI calls these functions so it
 * stays platform-agnostic.
 *
 * Hotkey customization is a desktop-only concern (Electron `globalShortcut` +
 * menu accelerators have no web/iOS analogue), so every function is a safe
 * no-op off Electron: `getHotkeys` resolves to an empty catalog, `setHotkey`
 * resolves without doing anything, and `onHotkeysChange` returns a no-op
 * unsubscribe. The settings route is itself platform-gated, so these
 * fallbacks guard against accidental off-host calls and against an older
 * preload that predates the `hotkeys` channel (the macOS app and web bundle
 * don't release together, so a newer renderer can run against an older
 * preload).
 */
export type { ResolvedHotkey };

/** Fetch the resolved catalog of rebindable commands and their bindings. */
export async function getHotkeys(): Promise<ResolvedHotkey[]> {
  if (!isElectron()) return [];
  const bridge = window.vellum;
  if (!bridge?.hotkeys) return [];
  return bridge.hotkeys.get();
}

/**
 * Persist a single hotkey override. `null` reverts the command to its compiled
 * default, `""` disables the binding, and any other string is a custom
 * accelerator (validated by the main process, which rejects the promise on an
 * invalid value).
 */
export async function setHotkey(
  key: string,
  accelerator: string | null,
): Promise<void> {
  if (!isElectron()) return;
  const bridge = window.vellum;
  if (!bridge?.hotkeys) return;
  await bridge.hotkeys.set(key, accelerator);
}

/**
 * Subscribe to hotkey-catalog changes broadcast by the main process (including
 * ones another window initiated). Returns an unsubscribe function; call it on
 * cleanup to avoid leaking the IPC listener.
 */
export function onHotkeysChange(
  callback: (catalog: ResolvedHotkey[]) => void,
): () => void {
  if (!isElectron()) return () => {};
  const bridge = window.vellum;
  if (!bridge?.hotkeys) return () => {};
  return bridge.hotkeys.onChange(callback);
}
