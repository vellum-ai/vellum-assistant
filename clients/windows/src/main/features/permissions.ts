import {
  BrowserWindow,
  Notification,
  app,
  shell,
  systemPreferences,
} from "electron";
import { z } from "zod";

import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import {
  PERMISSIONS_GET_STATE,
  PERMISSIONS_OPEN_SETTINGS,
  PERMISSIONS_QUIT_AND_REOPEN,
  PERMISSIONS_REQUEST,
  PERMISSIONS_STATE_EVENT,
  SYSTEM_PERMISSION_KINDS,
  SYSTEM_PERMISSION_STATUSES,
  TEXT_INSERT,
  TEXT_OPEN_SETTINGS,
  type SystemPermissionKind,
  type SystemPermissionStateItem,
  type SystemPermissionStatus,
  type SystemPermissionsState,
  type TextInsertionResult,
} from "@vellumai/ipc-contract";

import { handle } from "../ipc.client";
import log from "../logger";
import { current } from "../main-window";
import { getWindowsHelperClient } from "../windows-helper";

/**
 * Provider backed by the Vellum.WindowsHelper sidecar (`permissions.state`
 * and `text.insert` RPC methods). Registered at composition time; until
 * then helper-backed kinds are unavailable instead of faking a status.
 */
export interface WindowsPermissionsNativeProvider {
  queryPermissions(): Promise<
    Partial<Record<SystemPermissionKind, SystemPermissionStatus>>
  >;
  insertText(text: string): Promise<{ status: string; reason?: string }>;
}

let nativeProvider: WindowsPermissionsNativeProvider | null = null;

export const configureWindowsPermissionsNative = (
  provider: WindowsPermissionsNativeProvider | null,
): void => {
  nativeProvider = provider;
};

const nativeStatusSchema = z.object({
  microphone: z.enum(SYSTEM_PERMISSION_STATUSES).optional(),
  screen: z.enum(SYSTEM_PERMISSION_STATUSES).optional(),
  speechRecognition: z.enum(SYSTEM_PERMISSION_STATUSES).optional(),
  notifications: z.enum(SYSTEM_PERMISSION_STATUSES).optional(),
});

const nativeInsertionSchema = z.object({
  status: z.string(),
  reason: z.string().nullable().optional(),
});

const createNativeProvider = (): WindowsPermissionsNativeProvider => ({
  async queryPermissions() {
    return nativeStatusSchema.parse(
      await getWindowsHelperClient().call("permissions.state"),
    );
  },
  async insertText(text) {
    const result = nativeInsertionSchema.parse(
      await getWindowsHelperClient().call("text.insert", { text }),
    );
    return result.reason === null || result.reason === undefined
      ? { status: result.status }
      : { status: result.status, reason: result.reason };
  },
});

const kindSchema = z.enum(SYSTEM_PERMISSION_KINDS);

// Settings deep links for the kinds a Windows user can actually change;
// absent kinds have no Windows permission concept or remediation surface.
const SETTINGS_URIS: Partial<Record<SystemPermissionKind, string>> = {
  screen: "ms-settings:privacy-graphicscaptureprogrammatic",
  microphone: "ms-settings:privacy-microphone",
  speechRecognition: "ms-settings:privacy-speech",
  notifications: "ms-settings:notifications",
};

const PRIVACY_SETTINGS_URI = "ms-settings:privacy";

const NOT_APPLICABLE_KINDS = new Set<SystemPermissionKind>([
  "accessibility",
  "inputMonitoring",
  "automation",
]);

const mapMediaStatus = (status: string): SystemPermissionStatus =>
  SYSTEM_PERMISSION_STATUSES.includes(status as SystemPermissionStatus)
    ? (status as SystemPermissionStatus)
    : "unknown";

const allWindowsWebContents = () =>
  BrowserWindow.getAllWindows()
    .filter((win) => !win.isDestroyed() && !win.webContents.isDestroyed())
    .map((win) => win.webContents);

class WindowsPermissionsService {
  private lastStateJson: string | null = null;
  // Probe result plus the native status seen when probing. Dropped when the
  // native status changes or the window regains focus, since the per-app
  // toggle is invisible to the helper and the user may have changed it.
  private notificationProbe: {
    status: SystemPermissionStatus;
    nativeStatus: SystemPermissionStatus | undefined;
  } | null = null;

  async state(): Promise<SystemPermissionsState> {
    const native = await this.readNativeStatuses();
    return Object.fromEntries(
      SYSTEM_PERMISSION_KINDS.map((kind) => [kind, this.item(kind, native)]),
    ) as SystemPermissionsState;
  }

  async refresh(): Promise<SystemPermissionsState> {
    const state = await this.state();
    this.broadcastIfChanged(state);
    return state;
  }

  // Windows has no programmatic permission prompt for desktop apps except
  // notifications, which are probed by showing one. Everything else can only
  // be changed from the matching Settings page.
  async request(
    kind: SystemPermissionKind,
  ): Promise<SystemPermissionStateItem> {
    if (kind === "notifications") {
      const native = await this.readNativeStatuses();
      this.notificationProbe = {
        status: await this.probeNotifications(),
        nativeStatus: native.notifications,
      };
      return (await this.refresh())[kind];
    }
    return this.openSettings(kind);
  }

  // A change made in Windows Settings is picked up by the refresh that runs
  // when the app window regains focus.
  async openSettings(
    kind: SystemPermissionKind,
  ): Promise<SystemPermissionStateItem> {
    const uri = SETTINGS_URIS[kind];
    if (uri) {
      await shell.openExternal(uri);
    }
    return (await this.refresh())[kind];
  }

  refreshOnFocus(): Promise<SystemPermissionsState> {
    this.notificationProbe = null;
    return this.refresh();
  }

  quitAndReopen(): void {
    app.relaunch();
    app.quit();
  }

  private async readNativeStatuses(): Promise<
    Partial<Record<SystemPermissionKind, SystemPermissionStatus>>
  > {
    if (!nativeProvider) {
      return {};
    }
    try {
      return await nativeProvider.queryPermissions();
    } catch (err) {
      log.warn("[permissions] native permission query failed:", err);
      return {};
    }
  }

  private item(
    kind: SystemPermissionKind,
    native: Partial<Record<SystemPermissionKind, SystemPermissionStatus>>,
  ): SystemPermissionStateItem {
    const status = this.readStatus(kind, native);
    const settled = status === "granted" || status === "restricted";
    return {
      kind,
      status,
      canRequest: kind === "notifications" && !settled,
      canOpenSettings: kind in SETTINGS_URIS && status !== "granted",
      requiresRestart: false,
    };
  }

  private readStatus(
    kind: SystemPermissionKind,
    native: Partial<Record<SystemPermissionKind, SystemPermissionStatus>>,
  ): SystemPermissionStatus {
    if (NOT_APPLICABLE_KINDS.has(kind)) {
      return "not-applicable";
    }
    const probe = this.notificationProbe;
    if (
      kind === "notifications" &&
      probe &&
      probe.nativeStatus === native.notifications
    ) {
      return probe.status;
    }
    if (native[kind]) {
      return native[kind];
    }
    // Screen is deliberately absent: Electron reports it as always granted
    // on Windows, so only the helper's consent-store read is trusted.
    if (kind === "microphone") {
      return mapMediaStatus(systemPreferences.getMediaAccessStatus(kind));
    }
    return "unknown";
  }

  private probeNotifications(): Promise<SystemPermissionStatus> {
    if (!Notification.isSupported()) {
      return Promise.resolve("restricted");
    }
    return new Promise((resolve) => {
      let settled = false;
      const settle = (status: SystemPermissionStatus) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(status);
      };
      const timeout = setTimeout(() => settle("unknown"), 30_000);
      timeout.unref?.();

      const notification = new Notification({
        title: "Vellum",
        body: "Notifications are enabled.",
      });
      notification.once("show", () => settle("granted"));
      notification.once("failed", () => settle("denied"));
      try {
        notification.show();
      } catch {
        settle("unknown");
      }
    });
  }

  private broadcastIfChanged(state: SystemPermissionsState): void {
    const stateJson = JSON.stringify(state);
    if (stateJson === this.lastStateJson) {
      return;
    }
    this.lastStateJson = stateJson;
    for (const webContents of allWindowsWebContents()) {
      webContents.send(PERMISSIONS_STATE_EVENT, state);
    }
  }
}

const insertIntoFrontApp = async (
  text: string,
): Promise<TextInsertionResult> => {
  if (BrowserWindow.getFocusedWindow() !== null) {
    return { status: "vellum-focused" };
  }
  if (!nativeProvider) {
    log.warn("[text-insertion] no native insertion provider registered");
    return { status: "blocked" };
  }
  try {
    const result = await nativeProvider.insertText(text);
    if (result.status === "inserted") {
      return { status: "inserted" };
    }
    log.warn("[text-insertion] helper refused insertion:", result.reason);
  } catch (err) {
    log.warn("[text-insertion] helper insertion failed:", err);
  }
  // Bring the app back so the user sees why nothing was inserted.
  current()?.show();
  return { status: "blocked" };
};

const permissionsFeature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "permissions",
  install: () => {
    configureWindowsPermissionsNative(createNativeProvider());
    const service = new WindowsPermissionsService();

    handle(PERMISSIONS_GET_STATE, z.tuple([]), () => service.refresh());
    handle(PERMISSIONS_REQUEST, z.tuple([kindSchema]), ([kind]) =>
      service.request(kind),
    );
    handle(PERMISSIONS_OPEN_SETTINGS, z.tuple([kindSchema]), ([kind]) =>
      service.openSettings(kind),
    );
    handle(PERMISSIONS_QUIT_AND_REOPEN, z.tuple([]), () => {
      service.quitAndReopen();
    });

    handle(TEXT_INSERT, z.tuple([z.string()]), ([text]) =>
      insertIntoFrontApp(text),
    );
    // Windows has no automation permission pane; land on the privacy hub.
    handle(TEXT_OPEN_SETTINGS, z.tuple([]), () =>
      shell.openExternal(PRIVACY_SETTINGS_URI),
    );

    app.on("browser-window-focus", () => {
      void service.refreshOnFocus();
    });
  },
};

export default permissionsFeature;
