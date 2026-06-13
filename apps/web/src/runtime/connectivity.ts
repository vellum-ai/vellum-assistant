import { isElectron, type ConnectivityState } from "@/runtime/is-electron";

export type { ConnectivityState };

/**
 * Subscribe to connectivity state changes from the Electron host.
 * No-op off Electron — returns an unsubscribe-noop.
 */
export function subscribeToConnectivity(
  callback: (state: ConnectivityState) => void,
): () => void {
  if (!isElectron()) return () => undefined;
  return window.vellum?.connectivity?.onState(callback) ?? (() => undefined);
}

/**
 * Report browser online/offline to the Electron host so main can fuse it
 * with backend health probes. No-op off Electron.
 */
export function reportDeviceOnline(online: boolean): void {
  if (!isElectron()) return;
  window.vellum?.connectivity?.setDevice(online);
}

/** Resolves null off Electron, when the bridge is unavailable, or when the
 * invocation fails — callers treat null as "no fresh state, change nothing". */
async function pullConnectivityState(
  invoke: () => Promise<ConnectivityState> | undefined,
): Promise<ConnectivityState | null> {
  if (!isElectron()) return null;
  try {
    return (await invoke()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Pull the Electron host's current connectivity state. Lets the renderer
 * re-sync after a missed `onState` broadcast (e.g. when the window regains
 * focus).
 */
export function getConnectivityState(): Promise<ConnectivityState | null> {
  return pullConnectivityState(() => window.vellum?.connectivity?.get());
}

/**
 * Trigger an immediate connectivity probe on the Electron host and resolve
 * with the post-probe state, so a manual retry can correct a renderer whose
 * banner state desynced from main.
 */
export function retryConnectivity(): Promise<ConnectivityState | null> {
  return pullConnectivityState(() => window.vellum?.connectivity?.retry());
}
