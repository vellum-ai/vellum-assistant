import { app, globalShortcut } from "electron";

import {
  GLOBAL_SHORTCUT_DEFAULTS,
  onHotkeyOverridesChange,
  readHotkeyOverride,
} from "./commands";

export interface GlobalShortcutLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

export interface GlobalShortcutOptions {
  handlers: Partial<Record<keyof typeof GLOBAL_SHORTCUT_DEFAULTS, () => void>>;
  logger: GlobalShortcutLogger;
}

/**
 * Resolve the accelerator for a global shortcut key, preferring the user
 * override from `settings.hotkeys.<key>` over the compiled default. An explicit
 * empty-string override means the user disabled the shortcut, so it resolves to
 * `""` and `registerAll` skips registering it.
 */
const resolveGlobalAccelerator = (key: string): string => {
  return readHotkeyOverride(key) ?? GLOBAL_SHORTCUT_DEFAULTS[key] ?? "";
};

/**
 * Track the last successfully registered accelerator for each global
 * shortcut key so re-registration on settings change can unregister the
 * previous binding before registering the new one.
 */
const registered = new Map<string, string>();

/**
 * Unregister all currently held global shortcuts so the next
 * `registerAll` pass starts from a clean slate. Without this,
 * swapping two shortcuts (e.g. globalHotkey ↔ quickInput) would
 * fail: the first `register` call would try to claim an accelerator
 * still held by the second key and Electron would reject it.
 */
const unregisterAll = (): void => {
  for (const [, accelerator] of registered) {
    globalShortcut.unregister(accelerator);
  }
  registered.clear();
};

const registerAll = ({ handlers, logger }: GlobalShortcutOptions): void => {
  unregisterAll();
  for (const key of Object.keys(GLOBAL_SHORTCUT_DEFAULTS)) {
    const accelerator = resolveGlobalAccelerator(key);
    if (!accelerator) {
      continue;
    }

    const handler = handlers[key];
    if (!handler) {
      continue;
    }

    const ok = globalShortcut.register(accelerator, handler);
    if (ok) {
      registered.set(key, accelerator);
      logger.info(`[global-shortcuts] registered ${key}: ${accelerator}`);
    } else {
      logger.warn(
        `[global-shortcuts] failed to register ${key}: ${accelerator} (possibly held by another app)`,
      );
    }
  }
};

let teardown: (() => void) | null = null;

/**
 * Register system-wide global shortcuts and subscribe to settings changes
 * so re-binding is immediate. Call once from `app.whenReady()`.
 */
export const installGlobalShortcuts = (
  options: GlobalShortcutOptions,
): void => {
  if (teardown) {
    return;
  }

  registerAll(options);

  const unsubscribe = onHotkeyOverridesChange(() => {
    registerAll(options);
  });

  const onQuit = (): void => {
    unregisterAll();
  };
  app.on("will-quit", onQuit);

  teardown = () => {
    unsubscribe();
    app.off("will-quit", onQuit);
    onQuit();
  };
};

export const __resetGlobalShortcutsForTesting = (): void => {
  teardown?.();
  teardown = null;
};
