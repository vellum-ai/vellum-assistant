import type { IpcHandle } from "./ipc";

export interface UpdaterLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Structural subset of electron-updater's AppUpdater used by auto-update. */
export interface DesktopAutoUpdater {
  logger: UpdaterLogger | null;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  channel: string | null;
  allowDowngrade: boolean;
  setFeedURL(options: { provider: "generic"; url: string }): void;
  checkForUpdates(): Promise<{
    downloadPromise?: Promise<unknown> | null;
  } | null>;
  quitAndInstall(): void;
  on(
    event: "checking-for-update" | "update-not-available",
    listener: () => void,
  ): unknown;
  on(
    event: "update-available" | "update-downloaded",
    listener: (info: { version: string }) => void,
  ): unknown;
  on(
    event: "download-progress",
    listener: (progress: {
      percent: number;
      transferred: number;
      total: number;
    }) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface AutoUpdateConfig {
  updater: DesktopAutoUpdater;
  ipc: { handle: IpcHandle };
  logger: UpdaterLogger;
  /** Release channel, e.g. "production". Also selects the updater channel. */
  environment: string;
  /** Channel- and architecture-specific generic feed URL. */
  feedUrl: string;
}

export type UpdateFeedPlatform = "mac-electron" | "win-electron";
