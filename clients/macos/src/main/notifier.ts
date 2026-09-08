/**
 * Loader for the native notifier addon (`native/notifier`, built by
 * `scripts/build-notifier.sh`).
 *
 * The addon is an optional resource: a checkout that never ran the build
 * script, or a build for another architecture, simply has no `.node` file. The
 * loader reports that as unavailable so the app falls back to Electron's own
 * notification path instead of failing to boot.
 */

import { app } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";

import log from "./logger";

const ADDON_FILENAME = "vellum-notifier.node";

/**
 * Kill switch for a build where the addon misbehaves: the loader reports
 * unavailable and every notification goes back through Electron.
 */
const DISABLE_ENV_VAR = "VELLUM_DISABLE_NATIVE_NOTIFIER";

export interface NotifierSender {
  id: string;
  name: string;
  avatarPngPath: string;
  conversationId: string;
}

export interface NotifierRequest {
  id: string;
  title: string;
  subtitle?: string;
  body: string;
  categoryId: string;
  actions: string[];
  sender?: NotifierSender;
}

export interface NotifierCategory {
  categoryId: string;
  actions: string[];
}

export interface NotifierEvent {
  kind: "shown" | "failed" | "click" | "action";
  actionIndex?: number;
  error?: string;
  /**
   * Present on `shown` when the notification posted without the Communication
   * Notification treatment, naming why. The notification itself is fine, so
   * this is diagnostic rather than a failure.
   */
  degraded?: string;
}

export interface NotifierAuthorizationResult {
  granted: boolean;
  error?: string;
}

export interface Notifier {
  /** False in an unbundled process, where UNUserNotificationCenter raises. */
  isSupported(): boolean;
  requestAuthorization(
    callback?: (result: NotifierAuthorizationResult) => void,
  ): void;
  /**
   * Registers notification categories with the notification center, unioned
   * with whatever is already registered.
   */
  registerCategories(categories: NotifierCategory[]): void;
  /** Hands the notification center's delegate back to whoever held it. */
  restoreDelegate(): void;
  show(
    request: NotifierRequest,
    callback: (event: NotifierEvent) => void,
  ): void;
}

const resolveAddonPath = (): string => {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "bin", "notifier")
    : path.join(app.getAppPath(), "resources", "notifier");
  return path.join(base, process.arch, ADDON_FILENAME);
};

const isNotifier = (value: unknown): value is Notifier => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<Notifier>;
  return (
    typeof candidate.isSupported === "function" &&
    typeof candidate.requestAuthorization === "function" &&
    typeof candidate.registerCategories === "function" &&
    typeof candidate.restoreDelegate === "function" &&
    typeof candidate.show === "function"
  );
};

// `undefined` means "not attempted yet"; `null` means "attempted, unavailable".
let cached: Notifier | null | undefined;

const loadNotifier = (): Notifier | null => {
  if (cached !== undefined) {
    return cached;
  }
  cached = null;
  if (process.env[DISABLE_ENV_VAR] === "1") {
    log.info(`[notifier] ${DISABLE_ENV_VAR}=1; using Electron notifications`);
    return cached;
  }
  const addonPath = resolveAddonPath();
  if (!existsSync(addonPath)) {
    log.info(
      `[notifier] no addon at ${addonPath}; using Electron notifications`,
    );
    return cached;
  }
  try {
    const addon = { exports: {} as unknown };
    process.dlopen(addon, addonPath);
    if (isNotifier(addon.exports)) {
      cached = addon.exports;
    } else {
      log.warn(`[notifier] addon at ${addonPath} is missing expected exports`);
    }
  } catch (error) {
    log.warn("[notifier] failed to load addon:", error);
  }
  return cached;
};

export const getNotifier = (): Notifier | null => loadNotifier();

/**
 * Prompts for notification authorization through the addon, which keeps the
 * notification center's delegate with the addon. Resolves `null` when the
 * addon is unavailable or the call throws, so callers can fall back.
 */
export const requestNotifierAuthorization =
  (): Promise<NotifierAuthorizationResult | null> => {
    const notifier = loadNotifier();
    if (!notifier) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: NotifierAuthorizationResult | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };
      try {
        notifier.requestAuthorization(settle);
      } catch (error) {
        log.warn("[notifier] requestAuthorization failed:", error);
        settle(null);
      }
    });
  };

/** Registers every notification category the app can post, once, at startup. */
export const registerNotifierCategories = (
  categories: NotifierCategory[],
): void => {
  const notifier = loadNotifier();
  if (!notifier) {
    return;
  }
  try {
    notifier.registerCategories(categories);
  } catch (error) {
    log.warn("[notifier] registerCategories failed:", error);
  }
};

/**
 * Returns the notification center's delegate to whoever held it before the
 * addon installed its own, so the app quits leaving the seat as it found it.
 */
export const restoreNotifierDelegate = (): void => {
  const notifier = loadNotifier();
  if (!notifier) {
    return;
  }
  try {
    notifier.restoreDelegate();
  } catch (error) {
    log.warn("[notifier] restoreDelegate failed:", error);
  }
};

// Test seam: clears the one-shot load result so a test can point the loader
// at a different path.
export const __resetNotifierForTesting = (): void => {
  cached = undefined;
};

// Test seam: stands in for an addon that cannot be dlopened off macOS.
export const __setNotifierForTesting = (notifier: Notifier | null): void => {
  cached = notifier;
};
