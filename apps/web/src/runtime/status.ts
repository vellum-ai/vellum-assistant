import { isElectron, type AssistantStatus } from "@/runtime/is-electron";

export type { AssistantStatus };

/**
 * Per-capability wrapper for the Electron host's menu-bar (Tray) status
 * indicator. Matches the `runtime/dock.ts` pattern: the renderer never
 * touches `window.vellum.*` directly — feature code calls this named
 * function and the cross-platform branch lives here.
 *
 * Publishes the assistant's connection status so the main process can drive
 * the Tray status dot and its thinking pulse. The renderer holds the live
 * lifecycle/auth/SSE state, so it is the source of truth; main owns only the
 * presentation. Fire-and-forget — no acknowledgement.
 *
 * Safe to call from any host — no-op off Electron.
 */
export function setAssistantStatus(status: AssistantStatus): void {
  if (!isElectron()) return;
  window.vellum?.status?.setConnection(status);
}
