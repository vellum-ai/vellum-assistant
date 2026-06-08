import { app, BrowserWindow, globalShortcut } from "electron";

import log from "./logger";
import { dispatchToMain } from "./main-window";
import { onStatusChange, type AssistantStatus } from "./status";

/**
 * Hybrid Escape monitor: registers a system-wide Escape shortcut only
 * when the assistant is actively processing AND the app has no focused
 * window. When any BrowserWindow gains focus the shortcut is released
 * so normal in-app Escape handling (modals, popovers, inputs) is
 * unaffected — the renderer's own keydown listener handles the
 * focused case.
 *
 * Electron's `globalShortcut` intercepts the keypress at the OS level
 * and swallows it (https://github.com/electron/electron/issues/13010),
 * so leaving Escape bound while focused would break every Escape-driven
 * UI affordance in both Vellum and other applications.
 *
 * References:
 * - https://www.electronjs.org/docs/latest/api/global-shortcut
 * - https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts
 */

let armed = false;
let thinking = false;
let hasFocusedWindow = false;

const shouldBeArmed = (): boolean => thinking && !hasFocusedWindow;

const arm = (): void => {
  if (armed) return;
  const ok = globalShortcut.register("Escape", () => {
    dispatchToMain({ kind: "cancelActiveAction" });
  });
  if (ok) {
    armed = true;
    log.info("[escape-monitor] armed global Escape shortcut");
  } else {
    log.warn(
      "[escape-monitor] failed to register Escape (possibly held by another app)",
    );
  }
};

const disarm = (): void => {
  if (!armed) return;
  globalShortcut.unregister("Escape");
  armed = false;
  log.info("[escape-monitor] disarmed global Escape shortcut");
};

const reconcile = (): void => {
  if (shouldBeArmed()) {
    arm();
  } else {
    disarm();
  }
};

let teardown: (() => void) | null = null;

/**
 * Install the escape monitor. Call once from `app.whenReady()`.
 * Subscribes to assistant status changes and window focus/blur events
 * to dynamically arm/disarm the global Escape shortcut.
 */
export const installEscapeMonitor = (): void => {
  if (teardown) return;

  // Determine initial focus state.
  hasFocusedWindow = BrowserWindow.getFocusedWindow() != null;

  const unsubscribeStatus = onStatusChange((status: AssistantStatus) => {
    thinking = status === "thinking";
    reconcile();
  });

  const onFocus = (): void => {
    hasFocusedWindow = true;
    reconcile();
  };

  const onBlur = (): void => {
    // After blur, check if ANY window still has focus (blur fires per-window;
    // another window in the app may have gained focus simultaneously).
    hasFocusedWindow = BrowserWindow.getFocusedWindow() != null;
    reconcile();
  };

  app.on("browser-window-focus", onFocus);
  app.on("browser-window-blur", onBlur);

  const onQuit = (): void => {
    disarm();
  };
  app.on("will-quit", onQuit);

  teardown = () => {
    unsubscribeStatus();
    app.off("browser-window-focus", onFocus);
    app.off("browser-window-blur", onBlur);
    app.off("will-quit", onQuit);
    disarm();
  };
};
