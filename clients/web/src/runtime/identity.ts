import { isElectron } from "@/runtime/is-electron";

/**
 * Per-capability wrapper for publishing the active assistant's display name
 * (e.g. "Aria") to the Electron host. Matches the `runtime/status.ts`
 * pattern: the renderer never touches `window.vellum.*` directly — feature
 * code calls this named function and the cross-platform branch lives here.
 *
 * The renderer holds the identity (`useAssistantIdentityStore`, fed by the
 * daemon `/identity` fetch + SSE `identity_changed`) and is the source of
 * truth; main owns only the presentation — the window title, the menu-bar
 * (Tray) tooltip / header, and the native About panel. Publish a blank string
 * to clear, at which point main falls back to the brand name. Fire-and-forget
 * — no acknowledgement.
 *
 * Safe to call from any host — no-op off Electron.
 */
export function setAssistantName(name: string): void {
  if (!isElectron()) return;
  window.vellum?.identity?.setName(name);
}
