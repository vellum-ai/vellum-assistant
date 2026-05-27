import { powerMonitor } from "electron";

/**
 * Wires `suspend` / `resume` listeners for diagnostic visibility into
 * sleep-cycle behavior. The renderer's existing `document.visibilitychange`
 * + `online` / `offline` listeners (see `apps/web/src/hooks/use-event-bus-init.ts`)
 * already react to most of what a renderer needs to do across system
 * sleep — Chromium fires `visibilitychange` when the screen sleeps — so
 * no IPC bridge to the renderer is exposed here yet.
 *
 * When a feature needs an explicit power signal beyond what
 * `visibilitychange` carries (e.g. graceful stream teardown that should
 * happen *before* the OS suspends the process, not after Chromium notices
 * the window is hidden), that feature's ticket extends this module with
 * an IPC channel and adds a bridge surface in the preload.
 *
 * For now the listeners log with a timestamp so we have a breadcrumb when
 * debugging reconnect behavior post-wake.
 */
export const installPowerMonitor = (): void => {
  powerMonitor.on("suspend", () => {
    console.log(`[power] suspend at ${new Date().toISOString()}`);
  });

  powerMonitor.on("resume", () => {
    console.log(`[power] resume at ${new Date().toISOString()}`);
  });
};
