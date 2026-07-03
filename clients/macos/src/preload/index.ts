import {
  contextBridge,
  ipcRenderer,
  webUtils,
  type IpcRendererEvent,
} from "electron";

import type {
  Lockfile,
  LockfileWriteResult,
} from "@vellumai/local-mode";
import type {
  AppVersionInfo,
  AssistantStatus,
  BundleScanData,
  ConnectivityState,
  DeepLink,
  DictationOverlayMessage,
  DictationOverlayState,
  DictationPartialEvent,
  DictationPartialsResult,
  FnPushToTalkResult,
  HelperRestartResult,
  HelperState,
  HotkeyEvent,
  LocalAssistantStatusResult,
  LocalUpgradeOptions,
  LocalWakeOptions,
  NotificationActionEvent,
  PowerEvent,
  ResolvedHotkey,
  ShowNotificationPayload,
  SystemPermissionKind,
  SystemPermissionStateItem,
  SystemPermissionsState,
  TextInsertionResult,
  UpdateState,
  VellumBridge,
  VellumCommand,
} from "@vellumai/ipc-contract";

export type {
  AppVersionInfo,
  AssistantStatus,
  BundleScanData,
  ConnectivityState,
  DeepLink,
  DictationOverlayMessage,
  DictationOverlayState,
  DictationPartialEvent,
  DictationPartialsResult,
  FnPushToTalkResult,
  HelperRestartResult,
  HelperState,
  HotkeyEvent,
  LocalAssistantStatusResult,
  NotificationActionEvent,
  PowerEvent,
  ResolvedHotkey,
  ShowNotificationPayload,
  SystemPermissionKind,
  SystemPermissionStateItem,
  SystemPermissionsState,
  TextInsertionResult,
  UpdateState,
  VellumBridge,
  VellumCommand,
};

const notImplemented = (name: string) => (): Promise<never> =>
  Promise.reject(new Error(`window.vellum.${name} is not implemented yet`));

const subscribeDictationEvent =
  (channel: string) =>
  (callback: (event: DictationPartialEvent) => void): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      payload: DictationPartialEvent,
    ) => {
      callback(payload);
    };
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.off(channel, handler);
    };
  };

const bridge: VellumBridge = {
  platform: "electron",
  app: {
    versionInfo: (): Promise<AppVersionInfo> =>
      ipcRenderer.invoke("vellum:app:versionInfo") as Promise<AppVersionInfo>,
    openWebsite: (): Promise<void> =>
      ipcRenderer.invoke("vellum:app:openWebsite") as Promise<void>,
  },
  text: {
    insertIntoFrontApp: (text: string): Promise<TextInsertionResult> =>
      ipcRenderer.invoke(
        "vellum:text:insertIntoFrontApp",
        text,
      ) as Promise<TextInsertionResult>,
    openAutomationSettings: (): Promise<void> =>
      ipcRenderer.invoke(
        "vellum:text:openAutomationSettings",
      ) as Promise<void>,
  },
  auth: {
    startOAuth: (options: {
      loginHint?: string;
      intent?: string;
    }): Promise<{ sessionToken: string }> =>
      ipcRenderer.invoke("vellum:auth:startOAuth", options) as Promise<{
        sessionToken: string;
      }>,
    cancelOAuth: (): Promise<void> =>
      ipcRenderer.invoke("vellum:auth:cancelOAuth") as Promise<void>,
    getSessionToken: (): string | null =>
      ipcRenderer.sendSync("vellum:auth:getSessionToken") as string | null,
    signOut: (): Promise<void> =>
      ipcRenderer.invoke("vellum:auth:signOut") as Promise<void>,
  },
  hotkeys: {
    get: (): Promise<ResolvedHotkey[]> =>
      ipcRenderer.invoke("vellum:hotkeys:get") as Promise<ResolvedHotkey[]>,
    set: (key: string, accelerator: string | null): Promise<void> =>
      ipcRenderer.invoke(
        "vellum:hotkeys:set",
        key,
        accelerator,
      ) as Promise<void>,
    onChange: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        catalog: ResolvedHotkey[],
      ): void => {
        callback(catalog);
      };
      ipcRenderer.on("vellum:hotkeys:changed", handler);
      return () => {
        ipcRenderer.off("vellum:hotkeys:changed", handler);
      };
    },
  },
  launchAtLogin: {
    get: (): Promise<boolean> =>
      ipcRenderer.invoke("vellum:launchAtLogin:get") as Promise<boolean>,
    set: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("vellum:launchAtLogin:set", enabled) as Promise<void>,
  },
  featureFlags: {
    set: (flags: Record<string, boolean>): void => {
      ipcRenderer.send("vellum:featureFlags:set", flags);
    },
  },
  diagnostics: {
    setShareDiagnostics: (enabled: boolean): void => {
      ipcRenderer.send("vellum:diagnostics:setShareDiagnostics", enabled);
    },
  },
  helper: {
    ping: () =>
      ipcRenderer.invoke("vellum:helper:ping") as Promise<"pong">,
    getState: () =>
      ipcRenderer.invoke("vellum:helper:state:get") as Promise<HelperState>,
    restart: () =>
      ipcRenderer.invoke(
        "vellum:helper:restart",
      ) as Promise<HelperRestartResult>,
    onState: (callback) => {
      const handler = (_event: IpcRendererEvent, payload: HelperState) => {
        callback(payload);
      };
      ipcRenderer.on("vellum:helper:state", handler);
      return () => {
        ipcRenderer.off("vellum:helper:state", handler);
      };
    },
    hotkey: {
      fnPushToTalk: (enable: boolean): Promise<FnPushToTalkResult> =>
        ipcRenderer.invoke(
          "vellum:helper:hotkey:fnPushToTalk",
          enable,
        ) as Promise<FnPushToTalkResult>,
      onEvent: (callback) => {
        const handler = (_event: IpcRendererEvent, payload: HotkeyEvent) => {
          callback(payload);
        };
        ipcRenderer.on("vellum:helper:hotkey:event", handler);
        return () => {
          ipcRenderer.off("vellum:helper:hotkey:event", handler);
        };
      },
    },
    dictation: {
      setPartials: (
        enable: boolean,
        deviceName?: string,
        pushAudio?: boolean,
      ): Promise<DictationPartialsResult> =>
        ipcRenderer.invoke(
          "vellum:helper:dictation:setPartials",
          enable,
          deviceName,
          pushAudio,
        ) as Promise<DictationPartialsResult>,
      pushAudioChunk: (chunk: ArrayBuffer): void => {
        ipcRenderer.send("vellum:helper:dictation:audio", chunk);
      },
      onPartial: subscribeDictationEvent("vellum:helper:dictation:partial"),
      onFinalized: subscribeDictationEvent(
        "vellum:helper:dictation:finalized",
      ),
      transcribe: (
        audio: ArrayBuffer,
      ): Promise<{ ok: boolean; reason?: string }> =>
        ipcRenderer.invoke(
          "vellum:helper:dictation:transcribe",
          audio,
        ) as Promise<{ ok: boolean; reason?: string }>,
      onTranscribed: subscribeDictationEvent(
        "vellum:helper:dictation:transcribed",
      ),
    },
  },
  permissions: {
    getState: (): Promise<SystemPermissionsState> =>
      ipcRenderer.invoke(
        "vellum:permissions:getState",
      ) as Promise<SystemPermissionsState>,
    request: (kind: SystemPermissionKind): Promise<SystemPermissionStateItem> =>
      ipcRenderer.invoke(
        "vellum:permissions:request",
        kind,
      ) as Promise<SystemPermissionStateItem>,
    openSettings: (
      kind: SystemPermissionKind,
    ): Promise<SystemPermissionStateItem> =>
      ipcRenderer.invoke(
        "vellum:permissions:openSettings",
        kind,
      ) as Promise<SystemPermissionStateItem>,
    quitAndReopen: (): Promise<void> =>
      ipcRenderer.invoke("vellum:permissions:quitAndReopen") as Promise<void>,
    onState: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        state: SystemPermissionsState,
      ) => {
        callback(state);
      };
      ipcRenderer.on("vellum:permissions:state", handler);
      return () => {
        ipcRenderer.off("vellum:permissions:state", handler);
      };
    },
  },
  commands: {
    on: (callback) => {
      const handler = (_event: IpcRendererEvent, command: VellumCommand) => {
        callback(command);
      };
      ipcRenderer.on("vellum:command", handler);
      return () => {
        ipcRenderer.off("vellum:command", handler);
      };
    },
  },
  status: {
    setConnection: (status: AssistantStatus): void => {
      ipcRenderer.send("vellum:status:connection", status);
    },
  },
  identity: {
    setName: (name: string): void => {
      ipcRenderer.send("vellum:identity:name", name);
    },
  },
  icon: {
    setAvatar: (png: Uint8Array | null): void => {
      ipcRenderer.send("vellum:icon:setAvatar", png);
    },
  },
  dock: {
    setBadge: (count: number): void => {
      ipcRenderer.send("vellum:dock:setBadge", count);
    },
  },
  localMode: {
    hatch: (species: string, remote?: string) =>
      ipcRenderer.invoke("vellum:localMode:hatch", species, remote) as Promise<{
        ok: boolean;
        assistantId?: string;
        error?: string;
      }>,
    readLockfile: () =>
      ipcRenderer.invoke("vellum:localMode:readLockfile") as Promise<Lockfile>,
    saveLockfileAssistant: (
      assistant: Record<string, unknown>,
      activeAssistant?: string,
    ) =>
      ipcRenderer.invoke(
        "vellum:localMode:saveLockfileAssistant",
        assistant,
        activeAssistant,
      ) as Promise<LockfileWriteResult>,
    replacePlatformAssistants: (
      platformAssistants: Array<Record<string, unknown>>,
      organizationId?: string,
    ) =>
      ipcRenderer.invoke(
        "vellum:localMode:replacePlatformAssistants",
        platformAssistants,
        organizationId,
      ) as Promise<LockfileWriteResult>,
    wake: (assistantId: string, options?: LocalWakeOptions) =>
      ipcRenderer.invoke("vellum:localMode:wake", assistantId, options) as Promise<{
        ok: boolean;
        error?: string;
      }>,
    upgrade: (assistantId: string, options?: LocalUpgradeOptions) =>
      ipcRenderer.invoke(
        "vellum:localMode:upgrade",
        assistantId,
        options,
      ) as Promise<{
        ok: boolean;
        version?: string;
        error?: string;
      }>,
    status: (assistantId: string) =>
      ipcRenderer.invoke(
        "vellum:localMode:status",
        assistantId,
      ) as Promise<LocalAssistantStatusResult>,
    retire: (assistantId: string) =>
      ipcRenderer.invoke("vellum:localMode:retire", assistantId) as Promise<{
        ok: boolean;
        error?: string;
      }>,
    sleep: (assistantId: string) =>
      ipcRenderer.invoke("vellum:localMode:sleep", assistantId) as Promise<{
        ok: boolean;
        error?: string;
      }>,
    guardianToken: (assistantId: string) =>
      ipcRenderer.invoke(
        "vellum:localMode:guardianToken",
        assistantId,
      ) as Promise<
        | { ok: true; accessToken: string }
        | { ok: false; status: number; error: string }
      >,
  },
  menu: {
    setPlatformSession: (has: boolean): Promise<void> =>
      ipcRenderer.invoke("vellum:menu:setPlatformSession", has) as Promise<void>,
  },
  mainWindow: {
    ensureVisible: (): Promise<void> =>
      ipcRenderer.invoke("vellum:mainWindow:ensureVisible") as Promise<void>,
    setOnboarding: (active: boolean): Promise<void> =>
      ipcRenderer.invoke(
        "vellum:mainWindow:setOnboarding",
        active,
      ) as Promise<void>,
  },
  power: {
    onEvent: (callback) => {
      const handler = (_event: IpcRendererEvent, payload: PowerEvent) => {
        callback(payload);
      };
      ipcRenderer.on("vellum:power:event", handler);
      return () => {
        ipcRenderer.off("vellum:power:event", handler);
      };
    },
  },
  deepLinks: {
    drain: (): Promise<DeepLink[]> =>
      ipcRenderer.invoke("vellum:deepLinks:drain") as Promise<DeepLink[]>,
    onLink: (callback) => {
      const handler = (_event: IpcRendererEvent, payload: DeepLink) => {
        callback(payload);
      };
      ipcRenderer.on("vellum:deepLinks:event", handler);
      // Tell main we're listening so it switches from "buffer" mode
      // to "broadcast only" mode. Without this, every live link
      // would also enter the buffer and be replayed on a future
      // drain (renderer reload, logout-relogin).
      ipcRenderer.send("vellum:deepLinks:subscribe");
      return () => {
        ipcRenderer.off("vellum:deepLinks:event", handler);
        ipcRenderer.send("vellum:deepLinks:unsubscribe");
      };
    },
  },
  fileOpen: {
    drain: (): Promise<string[]> =>
      ipcRenderer.invoke("vellum:fileOpen:drain") as Promise<string[]>,
    onFile: (callback) => {
      ipcRenderer.send("vellum:fileOpen:subscribe");
      const handler = (_event: IpcRendererEvent, filePath: string) => {
        callback(filePath);
      };
      ipcRenderer.on("vellum:fileOpen:event", handler);
      return () => {
        ipcRenderer.send("vellum:fileOpen:unsubscribe");
        ipcRenderer.off("vellum:fileOpen:event", handler);
      };
    },
  },
  paths: {
    // Synchronous — `webUtils.getPathForFile` runs entirely inside the
    // preload's renderer context (no IPC hop), which is required because
    // `File` objects can't be serialized across the renderer↔main boundary.
    getPathForFile: (file: File): string | null => {
      try {
        const path = webUtils.getPathForFile(file);
        return path ? path : null;
      } catch {
        return null;
      }
    },
  },
  feedback: {
    diagnostics: () =>
      ipcRenderer.invoke("vellum:feedback:diagnostics") as Promise<
        Record<string, unknown>
      >,
    logs: () =>
      ipcRenderer.invoke("vellum:feedback:logs") as Promise<string>,
  },
  connectivity: {
    onState: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        state: ConnectivityState,
      ) => {
        callback(state);
      };
      ipcRenderer.on("vellum:connectivity:state", handler);
      // Emit the current state so late subscribers (window loaded after
      // the first probe) don't wait for the next state transition.
      void (
        ipcRenderer.invoke("vellum:connectivity:get") as Promise<ConnectivityState>
      ).then(callback);
      return () => {
        ipcRenderer.off("vellum:connectivity:state", handler);
      };
    },
    get: () =>
      ipcRenderer.invoke(
        "vellum:connectivity:get",
      ) as Promise<ConnectivityState>,
    setDevice: (online: boolean): void => {
      ipcRenderer.send("vellum:connectivity:device", online);
    },
    retry: () =>
      ipcRenderer.invoke(
        "vellum:connectivity:retry",
      ) as Promise<ConnectivityState>,
  },
  notifications: {
    show: (
      payload: ShowNotificationPayload,
    ): Promise<{ success: boolean; errorMessage?: string }> =>
      ipcRenderer.invoke(
        "vellum:notifications:show",
        payload,
      ) as Promise<{ success: boolean; errorMessage?: string }>,
    onAction: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        event: NotificationActionEvent,
      ) => {
        callback(event);
      };
      ipcRenderer.on("vellum:notifications:action", handler);
      return () => {
        ipcRenderer.off("vellum:notifications:action", handler);
      };
    },
  },
  bundleConfirm: {
    getData: () =>
      ipcRenderer.invoke(
        "vellum:bundleConfirm:getData",
      ) as Promise<BundleScanData | null>,
    respond: (accepted: boolean): void => {
      ipcRenderer.send("vellum:bundleConfirm:respond", accepted);
    },
  },
  quickInput: {
    submit: (message: string): Promise<void> =>
      ipcRenderer.invoke("vellum:quickInput:submit", message) as Promise<void>,
    dismiss: (): Promise<void> =>
      ipcRenderer.invoke("vellum:quickInput:dismiss") as Promise<void>,
  },
  commandPalette: {
    open: (): Promise<void> =>
      ipcRenderer.invoke("vellum:commandPalette:open") as Promise<void>,
    dismiss: (): Promise<void> =>
      ipcRenderer.invoke("vellum:commandPalette:dismiss") as Promise<void>,
    select: (command: VellumCommand): Promise<void> =>
      ipcRenderer.invoke(
        "vellum:commandPalette:select",
        command,
      ) as Promise<void>,
  },
  dictationOverlay: {
    setState: (state: DictationOverlayMessage): void => {
      ipcRenderer.send("vellum:dictationOverlay:setState", state);
    },
    onState: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        payload: DictationOverlayState,
      ) => {
        callback(payload);
      };
      ipcRenderer.on("vellum:dictationOverlay:state", handler);
      return () => {
        ipcRenderer.off("vellum:dictationOverlay:state", handler);
      };
    },
    getState: (): Promise<DictationOverlayState | null> =>
      ipcRenderer.invoke(
        "vellum:dictationOverlay:getState",
      ) as Promise<DictationOverlayState | null>,
    requestStop: (): void => {
      ipcRenderer.send("vellum:dictationOverlay:requestStop");
    },
    onStopRequested: (callback) => {
      const handler = () => {
        callback();
      };
      ipcRenderer.on("vellum:dictationOverlay:stopRequested", handler);
      return () => {
        ipcRenderer.off("vellum:dictationOverlay:stopRequested", handler);
      };
    },
    setInteractive: (interactive: boolean): void => {
      ipcRenderer.send("vellum:dictationOverlay:setInteractive", interactive);
    },
  },
  popout: {
    open: (conversationId: string): Promise<void> =>
      ipcRenderer.invoke("vellum:popout:open", conversationId) as Promise<void>,
  },
  update: {
    getState: (): Promise<UpdateState> =>
      ipcRenderer.invoke("vellum:update:getState") as Promise<UpdateState>,
    check: (): Promise<void> =>
      ipcRenderer.invoke("vellum:update:check") as Promise<void>,
    install: (): Promise<void> =>
      ipcRenderer.invoke("vellum:update:install") as Promise<void>,
    onState: (callback) => {
      const handler = (_event: IpcRendererEvent, state: UpdateState) => {
        callback(state);
      };
      ipcRenderer.on("vellum:update:state", handler);
      return () => {
        ipcRenderer.off("vellum:update:state", handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld("vellum", bridge);

const vellumConfig = ipcRenderer.sendSync("vellum:config:get") as {
  webUrl: string;
  platformUrl: string;
  disablePlatform?: boolean;
  deviceId: string | null;
} | null;
if (vellumConfig) {
  contextBridge.exposeInMainWorld("__VELLUM_CONFIG__", vellumConfig);
}

const flagOverrides: Record<string, boolean | string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith("VELLUM_FLAG_") || value === undefined) continue;
  const flagKey = key
    .slice("VELLUM_FLAG_".length)
    .toLowerCase()
    .replace(/_/g, "-");
  const lower = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(lower)) flagOverrides[flagKey] = true;
  else if (["false", "0", "no", "off"].includes(lower))
    flagOverrides[flagKey] = false;
  else flagOverrides[flagKey] = value.trim();
}
if (Object.keys(flagOverrides).length > 0) {
  contextBridge.exposeInMainWorld("__VELLUM_FLAG_OVERRIDES__", flagOverrides);
}

declare global {
  interface Window {
    vellum: VellumBridge;
    __VELLUM_FLAG_OVERRIDES__?: Record<string, boolean | string>;
  }
}
