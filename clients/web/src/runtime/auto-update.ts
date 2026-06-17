import {
  isElectron,
  type UpdateState,
  type UpdateStatus,
} from "@/runtime/is-electron";

export type { UpdateState, UpdateStatus };

/**
 * Per-capability wrapper for the Electron host's auto-update bridge.
 * Matches the established shape (`app-info.ts`, `power-events.ts`,
 * `connectivity.ts`): feature code never touches `window.vellum.*`
 * directly, and the cross-platform branch lives here.
 *
 * Off Electron (web build, Capacitor iOS): all functions are safe
 * no-ops — `getUpdateState` returns idle, subscriptions return
 * unsubscribe-noops, and imperative triggers are swallowed.
 */

/** Snapshot the current update state. Returns idle off Electron. */
export async function getUpdateState(): Promise<UpdateState> {
  if (!isElectron()) return { status: "idle" };
  return (await window.vellum?.update?.getState()) ?? { status: "idle" };
}

/** Trigger a manual check for updates. No-op off Electron. */
export async function checkForUpdates(): Promise<void> {
  if (!isElectron()) return;
  await window.vellum?.update?.check();
}

/** Quit and install the downloaded update. No-op off Electron. */
export async function installUpdate(): Promise<void> {
  if (!isElectron()) return;
  await window.vellum?.update?.install();
}

/** Subscribe to update state changes. Returns an unsubscribe function. */
export function onUpdateState(
  callback: (state: UpdateState) => void,
): () => void {
  if (!isElectron()) return () => undefined;
  return window.vellum?.update?.onState(callback) ?? (() => undefined);
}
