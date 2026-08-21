/**
 * The `VellumBridge` interface — the shape of `window.vellum` as
 * implemented by the Electron preload script.
 *
 * Capability surfaces are required: the preload implements every method, so
 * this interface type-checks completeness at the implementation site.
 * Compatibility discriminators can be optional when an absent field has a
 * defined fallback, and a surface that only one desktop shell can back is
 * optional with a doc comment naming the shell that lacks it. The renderer's
 * `declare global` also makes version-skew-tolerant capabilities optional
 * because older preloads may not expose them.
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
  CompanionCharacter,
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
  TitleBarOverlayTheme,
  UpdateState,
  VellumCommand,
  VoiceActivityContent,
  VoiceActivityControl,
  VoiceActivityStart,
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

export type ElectronHostOS = "macos" | "windows";

/**
 * Result of `localMode.connectImport`. On success `assistantId` is the unique
 * local id the pairing was registered under, and `accessOnly` is true when the
 * bundle carried no refresh credential (the token expires without renewal).
 */
export type LocalConnectImportResult =
  | { ok: true; assistantId: string; accessOnly: boolean }
  | { ok: false; error: string };

/**
 * One paired-device row as returned by `localMode.listDevices`. Structural
 * duplicate of `@vellumai/local-mode`'s `DeviceRecord`, declared here so this
 * package has no `file:` dependency on local-mode (which carries a transitive
 * `file:` chain that breaks lockfile resolution in consumer packages; see the
 * lockfile types in `./types.ts`). The gateway stores only the HASHED device
 * id, so `hashedDeviceId` is both the display identifier and the revocation
 * key.
 */
export interface LocalPairedDeviceRecord {
  hashedDeviceId: string;
  platform: string;
  issuedAt: number | null;
  expiresAt: number | null;
  lastUsedAt: number | null;
  /** True when this row is the hosting machine's own guardian credential. */
  isCurrentHost?: boolean;
}

export type LocalListDevicesResult =
  | { ok: true; devices: LocalPairedDeviceRecord[] }
  | { ok: false; error: string };

export type LocalRevokeDeviceResult =
  { ok: true } | { ok: false; error: string };

export interface VellumBridge {
  platform: "electron";
  hostOS?: ElectronHostOS;
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
    /**
     * The macOS Fn push-to-talk surface. Absent on shells with no global
     * push-to-talk trigger (the Windows shell, whose configurable global
     * chord ships separately).
     */
    hotkey?: {
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
      transcribe?(
        audio: ArrayBuffer,
      ): Promise<DictationTranscribeResult>;
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
    /**
     * Publish the traits the assistant's character is composed from, so
     * surfaces that can render it live do, rather than showing the still that
     * `setAvatar` ships. `null` when the avatar is a custom image or absent.
     */
    setCharacter(character: CompanionCharacter | null): void;
  };
  dock: {
    setBadge(count: number): void;
  };
  share: {
    shareFile(bytes: Uint8Array, filename: string): Promise<void>;
  };
  localMode: {
    hatch(
      species: string,
      remote?: string,
    ): Promise<{ ok: boolean; assistantId?: string; error?: string }>;
    /** List the devices holding pairing tokens for a local assistant. */
    listDevices(assistantId: string): Promise<LocalListDevicesResult>;
    readLockfile(): Promise<Lockfile>;
    saveLockfileAssistant(
      assistant: Record<string, unknown>,
      activeAssistant?: string,
    ): Promise<LockfileWriteResult>;
    /**
     * Rename an existing lockfile entry. Unlike `saveLockfileAssistant`'s
     * upsert, the host refuses when the entry is missing or the on-disk
     * file is unreadable, so a stale renderer cache can never re-create a
     * retired assistant. Never touches the active assistant.
     */
    renameLockfileAssistant(
      assistantId: string,
      name: string,
    ): Promise<LockfileWriteResult>;
    replacePlatformAssistants(
      platformAssistants: Array<Record<string, unknown>>,
      organizationId?: string,
    ): Promise<LockfileWriteResult>;
    retire(assistantId: string): Promise<{ ok: boolean; error?: string }>;
    /**
     * Revoke one paired device's tokens on a local assistant's gateway.
     * Server-side: the device's next request is rejected.
     */
    revokeDevice(
      assistantId: string,
      hashedDeviceId: string,
    ): Promise<LocalRevokeDeviceResult>;
    /**
     * Forget a paired assistant (`cloud: "paired"`): remove its lockfile
     * entry and stored guardian token on this machine. Client-side only:
     * the remote assistant is never touched.
     */
    unpair(assistantId: string): Promise<LockfileWriteResult>;
    /**
     * Register a pairing bundle printed by `vellum pair` on another machine:
     * persist the guardian token and create a `cloud: "paired"` lockfile
     * entry, the write counterpart of `unpair`. `name` picks the local id
     * (its slug); omitted, the id derives from the bundle's device id.
     */
    connectImport(
      bundle: string,
      name?: string,
    ): Promise<LocalConnectImportResult>;
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
    /**
     * The top-level application menus: stable ids plus the shell's own
     * labels. Windows only: the shell hides the native frame (and the menu
     * bar with it), so the renderer draws the titles in its own title bar,
     * mapping the ids to localized labels.
     */
    titles?(): Promise<Array<{ id: string; label: string }>>;
    /**
     * Pop the native submenu with the given id at (`x`, `y`), in CSS pixels
     * relative to the window's web contents. Resolves when the menu closes.
     * Windows only, paired with `titles`.
     */
    popup?(id: string, x: number, y: number): Promise<void>;
  };
  mainWindow: {
    ensureVisible(): Promise<void>;
    setOnboarding(active: boolean): Promise<void>;
    /**
     * Paint the native caption buttons in the active theme's colors. Windows
     * only: the title-bar overlay is a Windows and Linux surface, and macOS
     * draws traffic lights the system themes itself, so the macOS preload
     * does not expose this.
     */
    setTitleBarOverlay?(colors: TitleBarOverlayTheme): Promise<void>;
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
  paths: {
    /**
     * Resolve a renderer `File` object to its native filesystem path. Backed
     * by Electron's `webUtils.getPathForFile`, which returns the absolute path
     * for files (and folders) sourced from a real drag-drop or file-picker
     * event. Returns `null` when no path is available (e.g. an in-memory
     * `File` constructed from a Blob).
     */
    getPathForFile(file: File): string | null;
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
    /**
     * Report where the Stop control sits (window-relative CSS pixels), or
     * null when there is none. Lets main hit-test the cursor itself on
     * platforms where forwarded mouse moves never reach the click-through
     * overlay.
     */
    setHitRegion(region: DictationOverlayHitRegion | null): void;
  };
  /**
   * The running live-voice session, as the desktop shows it. Two renderers use
   * different halves: the window holding the session drives `start`/`update`/
   * `end` and listens for `onControl`; the companion surface's own route reads
   * the session off `companion.onState` and presses `control`.
   *
   * Absent on shells without a companion surface (the Windows shell).
   */
  voiceActivity?: {
    start(state: VoiceActivityStart): void;
    update(content: VoiceActivityContent): void;
    end(): void;
    control(control: VoiceActivityControl): void;
    onControl(callback: (control: VoiceActivityControl) => void): () => void;
  };
  /**
   * The always-present companion surface (macOS), which is also where a running
   * session is shown. Only the surface's own route uses it: it reads the anchor
   * main computed from the window's position and the session main is holding,
   * and reports whether the pointer is over the pill so main can make the
   * window clickable without the transparent canvas swallowing clicks meant for
   * whatever is behind it.
   *
   * Absent on shells without a companion surface (the Windows shell).
   */
  companion?: {
    getState(): Promise<CompanionSurfaceState | null>;
    onState(callback: (state: CompanionSurfaceState) => void): () => void;
    setInteractive(interactive: boolean): void;
    /** Nudge the window, for dragging the surface around the desktop. */
    moveBy(dx: number, dy: number): void;
    /**
     * Ask for a live-voice session, which is what Talk does.
     *
     * The surface is its own renderer and holds no session, so the press is
     * handed to main and dispatched to the window that does. What comes back is
     * the session itself, on `onState`.
     */
    startVoice(): void;
    /**
     * Turn the session that reads the screen on or off, which is what Watch
     * does.
     *
     * One call for both edges, the way the `toggleWatch` command is: the
     * surface draws a single control and the window holding the session is the
     * only side that knows which edge a press is. What comes back is `watching`
     * on `onState`.
     */
    toggleWatch(): void;
    /**
     * Answer the summary question a finished watch session leaves on the
     * surface: open the report now, or not.
     *
     * See the `answerWatchRetro` command. Both answers travel, because the
     * window that ran the retrospective is the one holding the question; what
     * comes back either way is `watchRetro` going absent on `onState`.
     */
    answerWatchRetro(open: boolean): void;
    /**
     * Bring Vellum forward on the conversation the user was last in, which is
     * what pressing the avatar asks for.
     */
    activate(): void;
    /**
     * Whether the surface's composer is open, and with it whether the window
     * may take key status.
     *
     * The counterpart to `setInteractive`: mouse events are granted only while
     * the pointer is on the pill, and keystrokes only while there is a field to
     * put them in. A floating panel that held the keyboard after its field
     * closed would swallow what the user typed next into the app they are
     * actually working in.
     */
    setComposing(composing: boolean): void;
    /**
     * Send what the user typed. See the `companionSubmit` command: the first
     * message of a composer's life starts a conversation, the rest continue it,
     * and none of them raise the app.
     */
    submit(message: string, startsConversation: boolean): void;
    /**
     * Publish the assistant's name and the tail of the open conversation.
     *
     * The one call here the surface's own route does *not* make: it comes from
     * the window holding the conversation, the way `voiceActivity.update` comes
     * from the window holding the session. Main holds what arrives and pushes
     * it back down as part of `onState`.
     */
    setContext(context: CompanionContext): void;
    /**
     * Move the one-time introduction on, or end it early.
     *
     * `next` walks to the following beat and finishes past the last one;
     * `dismiss` is the Skip affordance. Either way main is what records that it
     * has been seen, so the run never comes back.
     */
    advanceIntro(action: CompanionIntroAction): void;
    /**
     * Open the surface's own menu, at the pointer.
     *
     * Built and popped in main, because a menu is a native window: the
     * renderer knows a right-click happened and nothing else. The items are
     * the ones the tray carries for the companion, so the two cannot come to
     * describe the surface differently.
     */
    showContextMenu(): void;
    /**
     * Open a link from the card in the user's browser.
     *
     * The surface's window denies every navigation and every `window.open`, so
     * an anchor cannot follow itself: the URL is handed to main, which is the
     * side allowed to open anything. Main validates the scheme, since a URL
     * arriving over IPC is untrusted whatever drew the anchor.
     */
    openLink(url: string): void;
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

/**
 * Every top-level `VellumBridge` capability, for runtime parity checks. The
 * `satisfies` below fails to compile when the interface gains a key this list
 * lacks.
 */
export const VELLUM_BRIDGE_KEYS = [
  "platform",
  "hostOS",
  "app",
  "text",
  "auth",
  "hotkeys",
  "launchAtLogin",
  "featureFlags",
  "diagnostics",
  "helper",
  "permissions",
  "commands",
  "status",
  "identity",
  "icon",
  "dock",
  "share",
  "localMode",
  "menu",
  "mainWindow",
  "power",
  "deepLinks",
  "fileOpen",
  "paths",
  "feedback",
  "connectivity",
  "notifications",
  "bundleConfirm",
  "quickInput",
  "commandPalette",
  "dictationOverlay",
  "voiceActivity",
  "companion",
  "popout",
  "update",
] as const satisfies readonly (keyof VellumBridge)[];

({}) satisfies Record<
  Exclude<keyof VellumBridge, (typeof VELLUM_BRIDGE_KEYS)[number]>,
  never
>;
