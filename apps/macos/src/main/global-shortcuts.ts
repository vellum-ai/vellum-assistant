import { app, globalShortcut } from "electron";

import { GLOBAL_SHORTCUT_DEFAULTS } from "./commands";
import log from "./logger";
import { ensureVisible } from "./main-window";
import { onSettingChange, readSetting } from "./settings";

/**
 * Resolve the accelerator for a global shortcut key, preferring the user
 * override from `settings.hotkeys.<key>` over the compiled default.
 */
const resolveGlobalAccelerator = (key: string): string => {
  const hotkeys = readSetting("hotkeys");
  if (hotkeys && typeof hotkeys === "object") {
    const override = (hotkeys as Record<string, unknown>)[key];
    if (typeof override === "string" && override.length > 0) {
      return override;
    }
  }
  return GLOBAL_SHORTCUT_DEFAULTS[key] ?? "";
};

/**
 * Track the last successfully registered accelerator for each global
 * shortcut key so re-registration on settings change can unregister the
 * previous binding before registering the new one.
 */
const registered = new Map<string, string>();

const registerOne = (key: string): void => {
  const prev = registered.get(key);
  if (prev) {
    globalShortcut.unregister(prev);
    registered.delete(key);
  }

  const accelerator = resolveGlobalAccelerator(key);
  if (!accelerator) return;

  const handler = HANDLERS[key];
  if (!handler) return;

  const ok = globalShortcut.register(accelerator, handler);
  if (ok) {
    registered.set(key, accelerator);
    log.info(`[global-shortcuts] registered ${key} → ${accelerator}`);
  } else {
    log.warn(
      `[global-shortcuts] failed to register ${key} → ${accelerator} (possibly held by another app)`,
    );
  }
};

const registerAll = (): void => {
  for (const key of Object.keys(GLOBAL_SHORTCUT_DEFAULTS)) {
    registerOne(key);
  }
};

const HANDLERS: Record<string, () => void> = {
  globalHotkey: () => {
    void ensureVisible();
  },
  quickInput: () => {
    // Quick input overlay is not yet implemented in Electron; this
    // placeholder ensures the shortcut is reserved and ready.
    void ensureVisible();
  },
};

let teardown: (() => void) | null = null;

/**
 * Register system-wide global shortcuts and subscribe to settings changes
 * so re-binding is immediate. Call once from `app.whenReady()`.
 */
export const installGlobalShortcuts = (): void => {
  if (teardown) return;

  registerAll();

  const unsubscribe = onSettingChange("hotkeys", () => {
    registerAll();
  });

  const onQuit = (): void => {
    globalShortcut.unregisterAll();
    registered.clear();
  };
  app.on("will-quit", onQuit);

  teardown = () => {
    unsubscribe();
    app.off("will-quit", onQuit);
    onQuit();
  };
};
