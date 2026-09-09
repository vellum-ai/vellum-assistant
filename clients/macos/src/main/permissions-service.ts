import { randomUUID } from "node:crypto";

import {
  BrowserWindow,
  Notification,
  app,
  desktopCapturer,
  shell,
  systemPreferences,
  type WebContents,
} from "electron";
import { z } from "zod";

import { runAppleScript } from "./appleScriptExecutor";
import {
  queryFreshMacHelperPermission,
  queryMacHelperPermission,
  requestMacHelperInputMonitoringPermission,
  requestMacHelperSpeechRecognitionPermission,
  type MacHelperPermissionKind,
} from "./hotkey-helper";
import { handle } from "./ipc";
import log from "./logger";
import {
  getNotifier,
  isNotifierSupported,
  requestNotifierAuthorization,
  type NotifierAuthorizationResult,
} from "./notifier";

export const PERMISSION_KINDS = [
  "accessibility",
  "screen",
  "microphone",
  "speechRecognition",
  "inputMonitoring",
  "automation",
  "notifications",
] as const;

export type PermissionKind = (typeof PERMISSION_KINDS)[number];

export const PERMISSION_STATUSES = [
  "unknown",
  "restricted",
  "denied",
  "not-determined",
  "granted",
] as const;

export type PermissionStatus = (typeof PERMISSION_STATUSES)[number];

export interface PermissionStateItem {
  kind: PermissionKind;
  status: PermissionStatus;
  canRequest: boolean;
  canOpenSettings: boolean;
  requiresRestart: boolean;
  error?: string;
}

export type PermissionsState = Record<PermissionKind, PermissionStateItem>;

const permissionKindSchema = z.enum(PERMISSION_KINDS);

const SECURITY_PANE_URL =
  "x-apple.systempreferences:com.apple.preference.security";

const SETTINGS_PANES: Record<PermissionKind, string> = {
  accessibility: `${SECURITY_PANE_URL}?Privacy_Accessibility`,
  screen: `${SECURITY_PANE_URL}?Privacy_ScreenCapture`,
  microphone: `${SECURITY_PANE_URL}?Privacy_Microphone`,
  speechRecognition: `${SECURITY_PANE_URL}?Privacy_SpeechRecognition`,
  inputMonitoring: `${SECURITY_PANE_URL}?Privacy_ListenEvent`,
  automation: `${SECURITY_PANE_URL}?Privacy_Automation`,
  notifications: "x-apple.systempreferences:com.apple.preference.notifications",
};

const AUTOMATION_PROBE_SCRIPT =
  'tell application "System Events" to get name of first process';

const HELPER_PERMISSION_KINDS = new Set<PermissionKind>([
  "speechRecognition",
  "inputMonitoring",
]);

const isMacHelperPermissionKind = (
  kind: PermissionKind,
): kind is MacHelperPermissionKind => HELPER_PERMISSION_KINDS.has(kind);

const mapMediaStatus = (status: string): PermissionStatus =>
  PERMISSION_STATUSES.includes(status as PermissionStatus)
    ? (status as PermissionStatus)
    : "unknown";

const describeError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const isAutomationDeniedError = (err: unknown): boolean => {
  const message = describeError(err).toLowerCase();
  return (
    message.includes("-1743") ||
    message.includes("-25211") ||
    message.includes("not authorized") ||
    message.includes("not authorised") ||
    message.includes("not allowed assistive access") ||
    message.includes("not allowed to send apple events") ||
    message.includes("not permitted to send apple events")
  );
};

const allWindowsWebContents = (): WebContents[] =>
  BrowserWindow.getAllWindows()
    .filter((win) => !win.isDestroyed() && !win.webContents.isDestroyed())
    .map((win) => win.webContents);

const resolveAppBundleId = (): string => {
  if (!app.isPackaged) return "com.github.Electron";
  const env = process.env.VELLUM_ENVIRONMENT || "production";
  return env === "production"
    ? "com.vellum.vellum-assistant-electron"
    : `com.vellum.vellum-assistant-electron-${env}`;
};

const settingsPaneUrl = (kind: PermissionKind): string => {
  if (kind !== "notifications") return SETTINGS_PANES[kind];
  return `${SETTINGS_PANES.notifications}?id=${encodeURIComponent(
    resolveAppBundleId(),
  )}`;
};

// A permission prompt waits on the user, so give them time to answer before
// the outcome is called unknown.
const NOTIFICATION_PROMPT_TIMEOUT_MS = 30_000;

// The probe posts a real notification, so the user reads this on whichever
// path delivered it.
const NOTIFICATION_CONFIRMATION_BODY = "Notifications are enabled.";

/**
 * Runs `probe` and resolves whatever it settles on, or `null` once `timeoutMs`
 * passes with no answer. The first settle wins, so a probe that answers twice
 * (or answers after the timeout) cannot change the outcome.
 */
const settleWithin = <T>(
  timeoutMs: number,
  probe: (settle: (value: T | null) => void) => void,
): Promise<T | null> =>
  new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(null);
    }, timeoutMs);
    timeout.unref?.();
    probe((value) => {
      clearTimeout(timeout);
      resolve(value);
    });
  });

/**
 * The Electron probe learns its answer by posting a notification, so a user
 * who allows sees a confirmation banner. The addon answers without posting
 * anything, so the native path posts the same banner itself. It carries no
 * category because it has no action buttons to route.
 */
const postNativeNotificationConfirmation = (): void => {
  const notifier = getNotifier();
  if (!notifier) {
    return;
  }
  try {
    notifier.show(
      {
        id: randomUUID(),
        title: "Vellum",
        body: NOTIFICATION_CONFIRMATION_BODY,
        categoryId: "",
        actions: [],
      },
      () => undefined,
    );
  } catch (error) {
    log.warn("[permissions] confirmation notification failed:", error);
  }
};

// Asking the addon rather than `electron.Notification.isSupported()`, which
// builds Electron's presenter and takes the notification center's delegate.
// Electron's own probe is consulted only when the addon cannot post, which is
// the case where the presenter gets built anyway.
const initialNotificationStatus = (): PermissionStatus =>
  isNotifierSupported() || Notification.isSupported()
    ? "unknown"
    : "restricted";

export class PermissionsService {
  private lastStateJson: string | null = null;
  private pollTimers = new Map<PermissionKind, ReturnType<typeof setInterval>>();
  private automationStatus: PermissionStatus = "unknown";
  private notificationStatus: PermissionStatus = initialNotificationStatus();

  async state(sender?: WebContents): Promise<PermissionsState> {
    const entries = await Promise.all(
      PERMISSION_KINDS.map(
        async (kind) => [kind, await this.item(kind, sender)] as const,
      ),
    );
    return Object.fromEntries(entries) as PermissionsState;
  }

  async refresh(sender?: WebContents): Promise<PermissionsState> {
    const state = await this.state(sender);
    this.broadcastIfChanged(state);
    return state;
  }

  async request(
    kind: PermissionKind,
    sender?: WebContents,
  ): Promise<PermissionStateItem> {
    try {
      switch (kind) {
        case "accessibility":
          systemPreferences.isTrustedAccessibilityClient(true);
          break;
        case "microphone":
          await systemPreferences.askForMediaAccess("microphone");
          break;
        case "screen":
          await desktopCapturer.getSources({
            types: ["screen"],
            thumbnailSize: { width: 1, height: 1 },
          });
          break;
        case "speechRecognition":
          await requestMacHelperSpeechRecognitionPermission();
          break;
        case "inputMonitoring":
          await requestMacHelperInputMonitoringPermission();
          break;
        case "automation":
          await this.requestAutomation();
          break;
        case "notifications":
          await this.requestNotifications(sender);
          break;
      }
    } catch (err) {
      log.warn(`[permissions] request ${kind} failed:`, err);
    }

    const item = await this.item(kind, sender);
    if (item.status === "unknown" || item.status === "not-determined") {
      this.startPolling(kind, sender);
    }
    await this.refresh(sender);
    return item;
  }

  async openSettings(
    kind: PermissionKind,
    sender?: WebContents,
  ): Promise<PermissionStateItem> {
    if (kind === "inputMonitoring") {
      await requestMacHelperInputMonitoringPermission();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await shell.openExternal(settingsPaneUrl(kind));
    this.startPolling(kind, sender);
    return this.item(kind, sender);
  }

  quitAndReopen(): void {
    app.relaunch();
    app.quit();
  }

  private async item(
    kind: PermissionKind,
    sender?: WebContents,
  ): Promise<PermissionStateItem> {
    let status: PermissionStatus = "unknown";
    let error: string | undefined;

    try {
      status = await this.readStatus(kind, sender);
    } catch (err) {
      error = describeError(err);
      log.warn(`[permissions] read ${kind} failed:`, err);
    }

    return {
      kind,
      status,
      canRequest: this.canRequest(kind, status),
      canOpenSettings: status !== "granted",
      requiresRestart: kind === "screen" && status === "denied",
      ...(error ? { error } : {}),
    };
  }

  private async readStatus(
    kind: PermissionKind,
    sender?: WebContents,
  ): Promise<PermissionStatus> {
    switch (kind) {
      case "accessibility":
        return systemPreferences.isTrustedAccessibilityClient(false)
          ? "granted"
          : "denied";
      case "screen":
        return mapMediaStatus(systemPreferences.getMediaAccessStatus("screen"));
      case "microphone":
        return mapMediaStatus(
          systemPreferences.getMediaAccessStatus("microphone"),
        );
      case "speechRecognition":
        return await queryFreshMacHelperPermission(kind);
      case "inputMonitoring":
        return isMacHelperPermissionKind(kind)
          ? await queryMacHelperPermission(kind)
          : "unknown";
      case "automation":
        return await this.readAutomationStatus();
      case "notifications":
        return await this.readNotificationStatus(sender);
    }
  }

  private canRequest(kind: PermissionKind, status: PermissionStatus): boolean {
    if (status === "restricted" || status === "granted") return false;
    if (kind === "screen") {
      return status === "not-determined" || status === "unknown";
    }
    return true;
  }

  private async readAutomationStatus(): Promise<PermissionStatus> {
    return this.automationStatus;
  }

  private async requestAutomation(): Promise<void> {
    // AppleEvents has no harmless read API; only probe after an explicit user
    // request so opening Settings never triggers a surprise macOS prompt.
    try {
      await runAppleScript(AUTOMATION_PROBE_SCRIPT);
      this.automationStatus = "granted";
    } catch (err) {
      this.automationStatus = isAutomationDeniedError(err)
        ? "denied"
        : "unknown";
    }
  }

  private async readNotificationStatus(
    _sender?: WebContents,
  ): Promise<PermissionStatus> {
    return this.notificationStatus;
  }

  private requestNotifications(_sender?: WebContents): Promise<void> {
    // An addon that loads but reports unsupported is not a dead end: Electron
    // can still post, so the probe falls back to it rather than calling the
    // permission restricted.
    if (isNotifierSupported()) {
      return this.requestNativeNotifications();
    }
    return this.requestElectronNotifications();
  }

  // Prompting through the addon rather than `electron.Notification` is half of
  // what keeps the delegate with the addon; see the delegate rule in README.md.
  private async requestNativeNotifications(): Promise<void> {
    const result = await settleWithin<NotifierAuthorizationResult>(
      NOTIFICATION_PROMPT_TIMEOUT_MS,
      (settle) => {
        void requestNotifierAuthorization().then(settle);
      },
    );
    if (result === null) {
      this.notificationStatus = "unknown";
      return;
    }
    this.notificationStatus = result.granted ? "granted" : "denied";
    if (result.granted) {
      postNativeNotificationConfirmation();
    }
  }

  private async requestElectronNotifications(): Promise<void> {
    if (!Notification.isSupported()) {
      this.notificationStatus = "restricted";
      return;
    }
    const status = await settleWithin<PermissionStatus>(
      NOTIFICATION_PROMPT_TIMEOUT_MS,
      (settle) => {
        const notification = new Notification({
          title: "Vellum",
          body: NOTIFICATION_CONFIRMATION_BODY,
          silent: false,
        });
        notification.once("show", () => settle("granted"));
        notification.once("failed", () => settle("denied"));
        try {
          notification.show();
        } catch {
          settle(null);
        }
      },
    );
    this.notificationStatus = status ?? "unknown";
  }

  private startPolling(kind: PermissionKind, sender?: WebContents): void {
    this.stopPolling(kind);
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      void this.refresh(sender).then((state) => {
        if (state[kind].status === "granted" || attempts >= 150) {
          this.stopPolling(kind);
        }
      });
    }, 2_000);
    timer.unref?.();
    this.pollTimers.set(kind, timer);
  }

  private stopPolling(kind: PermissionKind): void {
    const timer = this.pollTimers.get(kind);
    if (!timer) return;
    clearInterval(timer);
    this.pollTimers.delete(kind);
  }

  private broadcastIfChanged(state: PermissionsState): void {
    const stateJson = JSON.stringify(state);
    if (stateJson === this.lastStateJson) return;
    this.lastStateJson = stateJson;
    for (const webContents of allWindowsWebContents()) {
      webContents.send("vellum:permissions:state", state);
    }
  }
}

export const installPermissionsService = (): PermissionsService => {
  const service = new PermissionsService();

  handle("vellum:permissions:getState", z.tuple([]), (_args, event) =>
    service.refresh(event.sender),
  );
  handle(
    "vellum:permissions:request",
    z.tuple([permissionKindSchema]),
    ([kind], event) => service.request(kind, event.sender),
  );
  handle(
    "vellum:permissions:openSettings",
    z.tuple([permissionKindSchema]),
    ([kind], event) => service.openSettings(kind, event.sender),
  );
  handle("vellum:permissions:quitAndReopen", z.tuple([]), () => {
    service.quitAndReopen();
  });

  app.on("browser-window-focus", (_event, window) => {
    void service.refresh(window.webContents);
  });

  return service;
};
