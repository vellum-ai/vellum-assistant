import { BrowserWindow, app, powerMonitor } from "electron";

import type { PowerEvent, PowerEventKind } from "@vellumai/ipc-contract";

/**
 * System power-state events: sleep/wake, screen lock/unlock, idle-recover.
 *
 * Why this exists when the renderer already has `visibilitychange`:
 * `visibilitychange` only fires on visibility transitions. A tray-resident
 * or full-screen app never goes hidden during sleep, so the renderer
 * doesn't see anything. Browser timers also freeze during system suspend;
 * on resume, `setInterval` doesn't retroactively fire missed ticks, and
 * WebSockets may appear "open" but be half-dead because the remote side
 * has TCP-RST'd while we slept. Subscribing to `powerMonitor` in main
 * surfaces the system-level signal so the renderer can reconnect
 * streams, refresh tokens, and bounce health probes on wake.
 *
 * Broadcast model: `webContents.send` to every BrowserWindow. The
 * About window (and any future auxiliary window the preload is attached
 * to) gets the same events; surfaces that don't care simply don't
 * subscribe, no handler runs.
 *
 * Debounce per kind: Electron has historically delivered duplicate
 * suspend/resume events on macOS — we collapse repeats within
 * `DEBOUNCE_MS` so renderer consumers don't see the same wake twice.
 *
 * Reference: https://www.electronjs.org/docs/latest/api/power-monitor
 */

export type { PowerEvent, PowerEventKind };

const DEBOUNCE_MS = 1_000;

// Most-recent emit timestamp per kind. Module-scope so tests can read
// the debounce behavior indirectly; reset on `installPowerEvents`.
const lastEmittedAt: Partial<Record<PowerEventKind, number>> = {};

const broadcast = (kind: PowerEventKind): void => {
  const now = Date.now();
  const last = lastEmittedAt[kind];
  if (last !== undefined && now - last < DEBOUNCE_MS) return;
  lastEmittedAt[kind] = now;
  const payload: PowerEvent = { kind };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send("vellum:power:event", payload);
  }
};

let installed = false;
export const installPowerEvents = (): void => {
  if (installed) return;
  installed = true;

  // Renderer-relevant `powerMonitor` events. `user-did-become-active`
  // fires when the user returns after a period of system-defined idle
  // — useful for nudging stale state on a long idle but not on sleep.
  powerMonitor.on("suspend", () => broadcast("suspend"));
  powerMonitor.on("resume", () => broadcast("resume"));
  powerMonitor.on("lock-screen", () => broadcast("lock"));
  powerMonitor.on("unlock-screen", () => broadcast("unlock"));
  powerMonitor.on("user-did-become-active", () => broadcast("active"));

  // Clear timestamps on quit so a hot-reload (dev) re-arms the debounce
  // window from zero on the next install.
  app.on("before-quit", () => {
    for (const kind of Object.keys(lastEmittedAt) as PowerEventKind[]) {
      delete lastEmittedAt[kind];
    }
  });
};

// Test seam — exported only for the unit test's setup. Production code
// uses `installPowerEvents` instead.
export const __resetForTesting = (): void => {
  installed = false;
  for (const kind of Object.keys(lastEmittedAt) as PowerEventKind[]) {
    delete lastEmittedAt[kind];
  }
};
