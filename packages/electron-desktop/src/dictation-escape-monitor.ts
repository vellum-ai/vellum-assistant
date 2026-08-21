import { app, BrowserWindow, globalShortcut } from "electron";

export interface DictationEscapeMonitor {
  install(): void;
  setRecording(recording: boolean): void;
}

export const createDictationEscapeMonitor = (options: {
  cancel: () => void;
  log: {
    info(message: string): void;
    warn(message: string): void;
  };
}): DictationEscapeMonitor => {
  let installed = false;
  let armed = false;
  let recording = false;
  let focused = false;

  const disarm = (): void => {
    if (!armed) {
      return;
    }
    globalShortcut.unregister("Escape");
    armed = false;
    options.log.info("[escape-monitor] disarmed global Escape shortcut");
  };

  const arm = (): void => {
    if (armed) {
      return;
    }
    const registered = globalShortcut.register("Escape", () => {
      // Lifecycle and focus can change after Electron queued the callback.
      if (recording && BrowserWindow.getFocusedWindow() == null) {
        options.cancel();
      }
    });
    if (registered) {
      armed = true;
      options.log.info("[escape-monitor] armed global Escape shortcut");
      return;
    }
    options.log.warn("[escape-monitor] failed to register Escape");
  };

  const reconcile = (): void => {
    if (recording && !focused) {
      arm();
    } else {
      disarm();
    }
  };

  const refreshFocus = (): void => {
    focused = BrowserWindow.getFocusedWindow() != null;
    reconcile();
  };

  const onFocus = (): void => {
    focused = true;
    reconcile();
  };

  const onBlur = (): void => {
    refreshFocus();
  };

  const onQuit = (): void => {
    disarm();
  };

  const install = (): void => {
    if (installed) {
      return;
    }
    installed = true;
    focused = BrowserWindow.getFocusedWindow() != null;
    app.on("browser-window-focus", onFocus);
    app.on("browser-window-blur", onBlur);
    app.on("will-quit", onQuit);
    reconcile();
  };

  const setRecording = (active: boolean): void => {
    if (recording === active) {
      return;
    }
    recording = active;
    refreshFocus();
  };

  return { install, setRecording };
};
