/**
 * The `VellumBridge` interface — the shape of `window.vellum` as
 * implemented by the Electron preload script.
 *
 * All surfaces are required: the preload implements every method, so this
 * interface type-checks completeness at the implementation site. The
 * renderer's `declare global` makes version-skew-tolerant surfaces
 * optional (older preloads may not expose them), which is a separate
 * concern handled at the consumer site.
 *
 * This is the single canonical definition of the bridge shape. The
 * preload types its `contextBridge.exposeInMainWorld` value against this
 * interface; the renderer references the payload types (from `./types.ts`)
 * in its ambient declaration.
 */
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
  Lockfile,
  LockfileWriteResult,
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
  VellumCommand,
} from "./types";

/**
 * Options for `localMode.wake`. `repairGuardian` re-provisions a
 * missing/expired guardian token via the CLI's `--repair-guardian` — it
 * revokes the assistant's other device-bound tokens, so callers must gate it
 * behind explicit user confirmation, never silent auto-repair.
 */
export interface LocalWakeOptions {
  repairGuardian?: boolean;
}

export interface LocalUpgradeOptions {
  version?: string;
  latest?: boolean;
  force?: boolean;
}

export interface VellumBridge {
  platform: "electron";
  app: {
    versionInfo(): Promise<AppVersionInfo>;
    openWebsite(): Promise<void>;
  };
  text: {
    insertIntoFrontApp(text: string): Promise<TextInsertionResult>;
    openAutomationSettings(): Promise<void>;
  };
  auth: {
    startOAuth(options: {
      loginHint?: string;
      intent?: string;
    }): Promise<{ sessionToken: string }>;
    cancelOAuth(): Promise<void>;
    getSessionToken(): string | null;
    signOut(): Promise<void>;
  };
  hotkeys: {
    get(): Promise<ResolvedHotkey[]>;
    set(key: string, accelerator: string | null): Promise<void>;
    onChange(callback: (catalog: ResolvedHotkey[]) => void): () => void;
  };
  launchAtLogin: {
    get(): Promise<boolean>;
    set(enabled: boolean): Promise<void>;
  };
  featureFlags: {
    set(flags: Record<string, boolean>): void;
  };
  diagnostics: {
    setShareDiagnostics(enabled: boolean): void;
  };
  helper: {
    ping(): Promise<"pong">;
    getState(): Promise<HelperState>;
    restart(): Promise<HelperRestartResult>;
    onState(callback: (state: HelperState) => void): () => void;
    hotkey: {
      fnPushToTalk(enable: boolean): Promise<FnPushToTalkResult>;
      onEvent(callback: (event: HotkeyEvent) => void): () => void;
    };
    dictation: {
      setPartials(
        enable: boolean,
        deviceName?: string,
        pushAudio?: boolean,
      ): Promise<DictationPartialsResult>;
      /** Fire-and-forget 16 kHz mono Int16 LE PCM for push-mode partials. */
      pushAudioChunk?(chunk: ArrayBuffer): void;
      onPartial(callback: (event: DictationPartialEvent) => void): () => void;
      /**
       * The session's completed transcript, delivered after a graceful
       * `setPartials(false)` — short dictations end before the first
       * partial, so the recognizer runs to completion instead of being
       * cancelled.
       */
      onFinalized?(
        callback: (event: DictationPartialEvent) => void,
      ): () => void;
      /**
       * One-shot whole-utterance recognition of recorded 16 kHz mono Int16
       * PCM — the offline transcript authority. Result arrives via
       * `onTranscribed`.
       */
      transcribe?(audio: ArrayBuffer): Promise<{ ok: boolean; reason?: string }>;
      onTranscribed?(
        callback: (event: DictationPartialEvent) => void,
      ): () => void;
    };
  };
  permissions: {
    getState(): Promise<SystemPermissionsState>;
    request(kind: SystemPermissionKind): Promise<SystemPermissionStateItem>;
    openSettings(
      kind: SystemPermissionKind,
    ): Promise<SystemPermissionStateItem>;
    quitAndReopen(): Promise<void>;
    onState(callback: (state: SystemPermissionsState) => void): () => void;
  };
  commands: {
    on(callback: (command: VellumCommand) => void): () => void;
  };
  status: {
    setConnection(status: AssistantStatus): void;
  };
  identity: {
    setName(name: string): void;
  };
  icon: {
    setAvatar(png: Uint8Array | null): void;
  };
  dock: {
    setBadge(count: number): void;
  };
  localMode: {
    hatch(
      species: string,
      remote?: string,
    ): Promise<{ ok: boolean; assistantId?: string; error?: string }>;
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
    sleep(assistantId: string): Promise<{ ok: boolean; error?: string }>;
    wake(
      assistantId: string,
      options?: LocalWakeOptions,
    ): Promise<{ ok: boolean; error?: string }>;
    upgrade(
      assistantId: string,
      options?: LocalUpgradeOptions,
    ): Promise<{ ok: boolean; version?: string; error?: string }>;
    status(assistantId: string): Promise<LocalAssistantStatusResult>;
    guardianToken(
      assistantId: string,
    ): Promise<
      | { ok: true; accessToken: string }
      | { ok: false; status: number; error: string }
    >;
  };
  menu: {
    setPlatformSession(has: boolean): Promise<void>;
  };
  mainWindow: {
    ensureVisible(): Promise<void>;
    setOnboarding(active: boolean): Promise<void>;
  };
  power: {
    onEvent(callback: (event: PowerEvent) => void): () => void;
  };
  deepLinks: {
    drain(): Promise<DeepLink[]>;
    onLink(callback: (link: DeepLink) => void): () => void;
  };
  fileOpen: {
    drain(): Promise<string[]>;
    onFile(callback: (filePath: string) => void): () => void;
  };
  feedback: {
    diagnostics(): Promise<Record<string, unknown>>;
    logs(): Promise<string>;
  };
  connectivity: {
    onState(callback: (state: ConnectivityState) => void): () => void;
    /** Pull the current state — lets the renderer re-sync after a missed
     * `onState` broadcast (e.g. on window focus). */
    get(): Promise<ConnectivityState>;
    setDevice(online: boolean): void;
    /** Probe immediately and resolve with the post-probe state, so a manual
     * retry recovers even when the broadcast channel failed. */
    retry(): Promise<ConnectivityState>;
  };
  notifications: {
    show(
      payload: ShowNotificationPayload,
    ): Promise<{ success: boolean; errorMessage?: string }>;
    onAction(callback: (event: NotificationActionEvent) => void): () => void;
  };
  bundleConfirm: {
    getData(): Promise<BundleScanData | null>;
    respond(accepted: boolean): void;
  };
  quickInput: {
    submit(message: string): Promise<void>;
    dismiss(): Promise<void>;
  };
  commandPalette: {
    open(): Promise<void>;
    dismiss(): Promise<void>;
    select(command: VellumCommand): Promise<void>;
  };
  dictationOverlay: {
    setState(state: DictationOverlayMessage): void;
    onState(callback: (state: DictationOverlayState) => void): () => void;
    getState(): Promise<DictationOverlayState | null>;
    requestStop(): void;
    onStopRequested(callback: () => void): () => void;
    setInteractive(interactive: boolean): void;
  };
  popout: {
    open(conversationId: string): Promise<void>;
  };
  update: {
    getState(): Promise<UpdateState>;
    check(): Promise<void>;
    install(): Promise<void>;
    onState(callback: (state: UpdateState) => void): () => void;
  };
}
