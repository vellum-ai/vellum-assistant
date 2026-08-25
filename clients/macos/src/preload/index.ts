import {
  contextBridge,
  ipcRenderer,
  webUtils,
  type IpcRendererEvent,
} from "electron";

import { createLocalModeBridge } from "@vellumai/electron-desktop/local-mode-bridge";
import {
  createFileOpenPreloadBridge,
} from "@vellumai/electron-desktop/file-open-preload";

import type {
  Lockfile,
  LockfileWriteResult,
} from "@vellumai/local-mode";
import type {
  AppVersionInfo,
  AssistantStatus,
  BundleScanData,
  CompanionContext,
  CompanionIntroAction,
  CompanionSurfaceState,
  ConnectivityState,
  DeepLink,
  DictationOverlayHitRegion,
  DictationOverlayMessage,
  DictationOverlayState,
  DictationPartialEvent,
  DictationPartialsResult,
  DictationTranscribeResult,
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
  VoiceActivityContent,
  VoiceActivityControl,
  VoiceActivityStart,
} from "@vellumai/ipc-contract";
import {
  DIAGNOSTICS_SET_SHARE,
  FEATURE_FLAGS_SET,
  FEEDBACK_DIAGNOSTICS,
  FEEDBACK_LOGS,
  HELPER_DICTATION_FINALIZED_EVENT,
  HELPER_DICTATION_PARTIAL_EVENT,
  HELPER_DICTATION_SET_PARTIALS,
  HELPER_DICTATION_TRANSCRIBE,
  HELPER_DICTATION_TRANSCRIBED_EVENT,
} from "@vellumai/ipc-contract";
import {
  createBundleConfirmBridge,
  createDeepLinksBridge,
  createDownloadsBridge,
  createHotkeysBridge,
  createLaunchAtLoginBridge,
  createUpdateBridge,
} from "@vellumai/electron-desktop/preload";

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

const fileOpenBridge = createFileOpenPreloadBridge({ ipcRenderer, webUtils });

const bridge: VellumBridge = {
  platform: "electron",
  hostOS: "macos",
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
  hotkeys: createHotkeysBridge(ipcRenderer),
  launchAtLogin: createLaunchAtLoginBridge(ipcRenderer),
  featureFlags: {
    set: (flags: Record<string, boolean>): void => {
      ipcRenderer.send(FEATURE_FLAGS_SET, flags);
    },
  },
  diagnostics: {
    setShareDiagnostics: (enabled: boolean): void => {
      ipcRenderer.send(DIAGNOSTICS_SET_SHARE, enabled);
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
          HELPER_DICTATION_SET_PARTIALS,
          enable,
          deviceName,
          pushAudio,
        ) as Promise<DictationPartialsResult>,
      pushAudioChunk: (chunk: ArrayBuffer): void => {
        ipcRenderer.send("vellum:helper:dictation:audio", chunk);
      },
      onPartial: subscribeDictationEvent(HELPER_DICTATION_PARTIAL_EVENT),
      onFinalized: subscribeDictationEvent(
        HELPER_DICTATION_FINALIZED_EVENT,
      ),
      transcribe: (
        audio: ArrayBuffer,
      ): Promise<DictationTranscribeResult> =>
        ipcRenderer.invoke(
          HELPER_DICTATION_TRANSCRIBE,
          audio,
        ) as Promise<DictationTranscribeResult>,
      onTranscribed: subscribeDictationEvent(
        HELPER_DICTATION_TRANSCRIBED_EVENT,
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
    setCharacter: (character): void => {
      ipcRenderer.send("vellum:icon:setCharacter", character);
    },
  },
  dock: {
    setBadge: (count: number): void => {
      ipcRenderer.send("vellum:dock:setBadge", count);
    },
  },
  share: {
    shareFile: (bytes: Uint8Array, filename: string): Promise<void> =>
      ipcRenderer.invoke("vellum:share:file", bytes, filename),
  },
  downloads: createDownloadsBridge(ipcRenderer),
  localMode: createLocalModeBridge(ipcRenderer),
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
  deepLinks: createDeepLinksBridge(ipcRenderer),
  fileOpen: fileOpenBridge.fileOpen,
  paths: fileOpenBridge.paths,
  feedback: {
    diagnostics: () =>
      ipcRenderer.invoke(FEEDBACK_DIAGNOSTICS) as Promise<
        Record<string, unknown>
      >,
    logs: () =>
      ipcRenderer.invoke(FEEDBACK_LOGS) as Promise<string>,
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
  bundleConfirm: createBundleConfirmBridge(ipcRenderer),
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
    setHitRegion: (region: DictationOverlayHitRegion | null): void => {
      ipcRenderer.send("vellum:dictationOverlay:setHitRegion", region);
    },
  },
  voiceActivity: {
    start: (state: VoiceActivityStart): void => {
      ipcRenderer.send("vellum:voiceActivity:start", state);
    },
    update: (content: VoiceActivityContent): void => {
      ipcRenderer.send("vellum:voiceActivity:update", content);
    },
    end: (): void => {
      ipcRenderer.send("vellum:voiceActivity:end");
    },
    control: (control: VoiceActivityControl): void => {
      ipcRenderer.send("vellum:voiceActivity:control", control);
    },
    onControl: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        payload: VoiceActivityControl,
      ) => {
        callback(payload);
      };
      ipcRenderer.on("vellum:voiceActivity:controlEvent", handler);
      return () => {
        ipcRenderer.off("vellum:voiceActivity:controlEvent", handler);
      };
    },
  },
  companion: {
    getState: (): Promise<CompanionSurfaceState | null> =>
      ipcRenderer.invoke(
        "vellum:companion:getState",
      ) as Promise<CompanionSurfaceState | null>,
    onState: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        state: CompanionSurfaceState,
      ) => {
        callback(state);
      };
      ipcRenderer.on("vellum:companion:state", handler);
      return () => {
        ipcRenderer.off("vellum:companion:state", handler);
      };
    },
    setInteractive: (interactive: boolean): void => {
      ipcRenderer.send("vellum:companion:setInteractive", interactive);
    },
    moveBy: (dx: number, dy: number): void => {
      ipcRenderer.send("vellum:companion:moveBy", dx, dy);
    },
    startVoice: (): void => {
      ipcRenderer.send("vellum:companion:startVoice");
    },
    toggleWatch: (): void => {
      ipcRenderer.send("vellum:companion:toggleWatch");
    },
    answerWatchRetro: (open: boolean): void => {
      ipcRenderer.send("vellum:companion:answerWatchRetro", open);
    },
    activate: (): void => {
      ipcRenderer.send("vellum:companion:activate");
    },
    setComposing: (composing: boolean): void => {
      ipcRenderer.send("vellum:companion:setComposing", composing);
    },
    submit: (message: string, startsConversation: boolean): void => {
      ipcRenderer.send(
        "vellum:companion:submit",
        message,
        startsConversation,
      );
    },
    setContext: (context: CompanionContext): void => {
      ipcRenderer.send("vellum:companion:setContext", context);
    },
    advanceIntro: (action: CompanionIntroAction): void => {
      ipcRenderer.send("vellum:companion:advanceIntro", action);
    },
    showContextMenu: (): void => {
      ipcRenderer.send("vellum:companion:contextMenu");
    },
    openLink: (url: string): void => {
      ipcRenderer.send("vellum:companion:openLink", url);
    },
  },
  popout: {
    open: (conversationId: string): Promise<void> =>
      ipcRenderer.invoke("vellum:popout:open", conversationId) as Promise<void>,
  },
  update: createUpdateBridge(ipcRenderer),
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
