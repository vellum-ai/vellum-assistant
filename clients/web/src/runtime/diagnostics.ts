import { isElectron } from "@/runtime/is-electron";

/**
 * Sync the diagnostics consent state to the Electron main process.
 * No-op on web and Capacitor iOS — the main-process Sentry client only
 * exists in the Electron shell.
 */
export function syncDiagnosticsToMain(enabled: boolean): void {
  if (!isElectron()) return;
  window.vellum?.diagnostics?.setShareDiagnostics(enabled);
}
