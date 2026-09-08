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

export interface NotifierEvent {
  kind: "shown" | "failed" | "click" | "action" | "dismiss";
  actionIndex?: number;
  error?: string;
}

export interface Notifier {
  /** False in an unbundled process, where UNUserNotificationCenter raises. */
  isSupported(): boolean;
  requestAuthorization(): void;
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

export const isNotifierAvailable = (): boolean => loadNotifier() !== null;

// Test seam: clears the one-shot load result so a test can point the loader
// at a different path.
export const __resetNotifierForTesting = (): void => {
  cached = undefined;
};
