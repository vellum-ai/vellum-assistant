/**
 * Ambient declaration of the `window.vellum` bridge exposed by the Electron
 * preload script (see `clients/macos/src/preload/index.ts`). Types are imported
 * from `@vellumai/ipc-contract` — the single source of truth for IPC payload
 * shapes shared by main, preload, and renderer.
 *
 * Feature code in `clients/web/` should NOT call `window.vellum.*` directly.
 * Instead, wrap each persisted capability in a per-feature module under
 * `clients/web/src/runtime/` with named functions (see `native-biometric.ts`
 * for the established shape: `isBiometricEnabled()` / `setBiometricEnabled()`).
 * The module owns the cross-platform branch — `isElectron()` calls into
 * `window.vellum`, `isNativePlatform()` calls Capacitor, and the web branch
 * uses `localStorage` — so consumers stay platform-agnostic.
 */
import type {
  Lockfile,
  LockfileWriteResult,
} from "@vellumai/local-mode/contract";
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
  HotkeyEventState,
  HotkeyScope,
  LocalAssistantStatusResult,
  LocalUpgradeOptions,
  LocalWakeOptions,
  NotificationActionEvent,
  NotificationCategory,
  PowerEvent,
  PowerEventKind,
  ResolvedHotkey,
  ShowNotificationPayload,
  SystemPermissionKind,
  SystemPermissionStateItem,
  SystemPermissionStatus,
  SystemPermissionsState,
  TextInsertionResult,
  UpdateState,
  UpdateStatus,
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
  HotkeyEventState,
  HotkeyScope,
  NotificationCategory,
  PowerEvent,
  PowerEventKind,
  ResolvedHotkey,
  SystemPermissionKind,
  SystemPermissionStateItem,
  SystemPermissionStatus,
  SystemPermissionsState,
  UpdateState,
  UpdateStatus,
  VellumCommand,
};

// Legacy aliases — existing consumers import these `Electron`-prefixed names.
// They are structurally identical to the contract types.
export type ElectronShowNotificationPayload = ShowNotificationPayload;
export type ElectronTextInsertionResult = TextInsertionResult;
export type ElectronNotificationActionEvent = NotificationActionEvent;

// ─── Window augmentation ────────────────────────────────────────────────
// The renderer's `window.vellum` declaration intentionally marks many
// capability groups optional for version-skew tolerance: a newer renderer
// can run against an older Electron preload that predates a channel.
// The `VellumBridge` interface in the contract represents the canonical
// (fully-wired) shape; the global declaration below is the renderer's
// defensive view that guards on presence.

declare global {
  interface Window {
    vellum?: {
      platform: "electron";
      app: {
        versionInfo(): Promise<AppVersionInfo>;
        openWebsite(): Promise<void>;
      };
      text?: {
        insertIntoFrontApp(text: string): Promise<TextInsertionResult>;
        openAutomationSettings(): Promise<void>;
      };
      hotkeys?: {
        get(): Promise<ResolvedHotkey[]>;
        set(key: string, accelerator: string | null): Promise<void>;
        onChange(callback: (catalog: ResolvedHotkey[]) => void): () => void;
      };
      launchAtLogin?: {
        get(): Promise<boolean>;
        set(enabled: boolean): Promise<void>;
      };
      featureFlags?: {
        set(flags: Record<string, boolean>): void;
      };
      diagnostics?: {
        setShareDiagnostics(enabled: boolean): void;
      };
      helper?: {
        ping?(): Promise<"pong">;
        getState?(): Promise<HelperState>;
        restart?(): Promise<HelperRestartResult>;
        onState?(callback: (state: HelperState) => void): () => void;
        hotkey?: {
          fnPushToTalk(enable: boolean): Promise<FnPushToTalkResult>;
          onEvent(callback: (event: HotkeyEvent) => void): () => void;
        };
        dictation?: {
          setPartials(
            enable: boolean,
            deviceName?: string,
            pushAudio?: boolean,
          ): Promise<DictationPartialsResult>;
          pushAudioChunk?(chunk: ArrayBuffer): void;
          onPartial(
            callback: (event: DictationPartialEvent) => void,
          ): () => void;
          onFinalized?(
            callback: (event: DictationPartialEvent) => void,
          ): () => void;
          transcribe?(
            audio: ArrayBuffer,
          ): Promise<{ ok: boolean; reason?: string }>;
          onTranscribed?(
            callback: (event: DictationPartialEvent) => void,
          ): () => void;
        };
      };
      permissions?: {
        getState(): Promise<SystemPermissionsState>;
        request(
          kind: SystemPermissionKind,
        ): Promise<SystemPermissionStateItem>;
        openSettings(
          kind: SystemPermissionKind,
        ): Promise<SystemPermissionStateItem>;
        quitAndReopen(): Promise<void>;
        onState(callback: (state: SystemPermissionsState) => void): () => void;
      };
      commands: {
        on(callback: (command: VellumCommand) => void): () => void;
      };
      status?: {
        setConnection(status: AssistantStatus): void;
      };
      identity?: {
        setName(name: string): void;
      };
      icon?: {
        setAvatar(png: Uint8Array | null): void;
      };
      dock: {
        setBadge(count: number): void;
      };
      menu: {
        setPlatformSession(has: boolean): Promise<void>;
      };
      localMode: {
        hatch(species: string, remote?: string): Promise<{
          ok: boolean;
          assistantId?: string;
          error?: string;
        }>;
        readLockfile(): Promise<Lockfile>;
        saveLockfileAssistant(
          assistant: Record<string, unknown>,
          activeAssistant?: string,
        ): Promise<LockfileWriteResult>;
        replacePlatformAssistants(
          platformAssistants: Array<Record<string, unknown>>,
          organizationId?: string,
        ): Promise<LockfileWriteResult>;
        retire(assistantId: string): Promise<{ ok: boolean; error?: string }>;
        sleep?(
          assistantId: string,
        ): Promise<{ ok: boolean; error?: string }>;
        wake?(
          assistantId: string,
          options?: LocalWakeOptions,
        ): Promise<{ ok: boolean; error?: string }>;
        upgrade?(
          assistantId: string,
          options?: LocalUpgradeOptions,
        ): Promise<{ ok: boolean; version?: string; error?: string }>;
        status?(
          assistantId: string,
        ): Promise<LocalAssistantStatusResult>;
        guardianToken(
          assistantId: string,
        ): Promise<
          | { ok: true; accessToken: string }
          | { ok: false; status: number; error: string }
        >;
      };
      auth?: {
        startOAuth(options: {
          loginHint?: string;
          intent?: string;
        }): Promise<{ sessionToken: string }>;
        cancelOAuth(): Promise<void>;
        getSessionToken?(): string | null;
        signOut?(): Promise<void>;
      };
      mainWindow: {
        ensureVisible(): Promise<void>;
        setOnboarding(active: boolean): Promise<void>;
      };
      power: {
        onEvent(
          callback: (event: PowerEvent) => void,
        ): () => void;
      };
      deepLinks: {
        drain(): Promise<DeepLink[]>;
        onLink(callback: (link: DeepLink) => void): () => void;
      };
      fileOpen?: {
        drain(): Promise<string[]>;
        onFile(callback: (filePath: string) => void): () => void;
      };
      paths?: {
        getPathForFile(file: File): string | null;
      };
      feedback?: {
        diagnostics(): Promise<Record<string, unknown>>;
        logs(): Promise<string>;
      };
      connectivity?: {
        onState(
          callback: (state: ConnectivityState) => void,
        ): () => void;
        get(): Promise<ConnectivityState>;
        setDevice(online: boolean): void;
        retry(): Promise<ConnectivityState>;
      };
      quickInput?: {
        submit(message: string): Promise<void>;
        dismiss(): Promise<void>;
      };
      commandPalette?: {
        open(): Promise<void>;
        dismiss(): Promise<void>;
        select(command: VellumCommand): Promise<void>;
      };
      dictationOverlay?: {
        setState(state: DictationOverlayMessage): void;
        onState(
          callback: (state: DictationOverlayState) => void,
        ): () => void;
        getState(): Promise<DictationOverlayState | null>;
        requestStop(): void;
        onStopRequested(callback: () => void): () => void;
        setInteractive(interactive: boolean): void;
      };
      notifications?: {
        show(
          payload: ShowNotificationPayload,
        ): Promise<{ success: boolean; errorMessage?: string }>;
        onAction(
          callback: (event: NotificationActionEvent) => void,
        ): () => void;
      };
      popout?: {
        open(conversationId: string): Promise<void>;
      };
      bundleConfirm?: {
        getData(): Promise<BundleScanData | null>;
        respond(accepted: boolean): void;
      };
      update?: {
        getState(): Promise<UpdateState>;
        check(): Promise<void>;
        install(): Promise<void>;
        onState(callback: (state: UpdateState) => void): () => void;
      };
    };
  }
}

/**
 * True when the renderer is running inside the Electron host. Safe to call
 * server-side / before hydration — falls through to `false` when `window`
 * isn't defined yet.
 *
 * Use this to branch behavior that differs between the web host and the
 * Electron host. For branches that differ between web and Capacitor iOS,
 * use `isNativePlatform` from `@/runtime/native-auth.js` instead.
 */
export function isElectron(): boolean {
  return typeof window !== "undefined" && window.vellum?.platform === "electron";
}
