import type { BrowserWindow } from "electron";

// A renderer that dies again this soon after a crash reload is crashing on
// load, and reloading it again would only loop.
export const CRASH_LOOP_MS = 30_000;

/**
 * Reload a window's page when its renderer process dies, so a crash (an
 * out-of-memory kill, a GPU fault) costs the page state instead of leaving a
 * blank window until the app restarts. The reload keeps the last committed URL,
 * so the user lands back on the route they were on.
 */
export const reloadOnRendererCrash = (win: BrowserWindow): void => {
  let lastReloadAt = Number.NEGATIVE_INFINITY;
  win.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit" || win.isDestroyed()) {
      return;
    }
    const now = Date.now();
    if (now - lastReloadAt < CRASH_LOOP_MS) {
      console.error(
        `[renderer-crash] renderer gone again (${details.reason}) within ${CRASH_LOOP_MS}ms of a reload; not reloading`,
      );
      return;
    }
    lastReloadAt = now;
    console.warn(
      `[renderer-crash] renderer gone (${details.reason}, exit code ${details.exitCode}); reloading`,
    );
    win.webContents.reload();
  });
};
