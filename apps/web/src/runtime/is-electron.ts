/**
 * Minimal ambient declaration of the `window.vellum` bridge exposed by the
 * Electron preload script (see `apps/macos/src/preload/index.ts`). Surface is
 * expanded here as each follow-up ticket wires a real implementation, keeping
 * the renderer's view of the bridge honest about what's actually available
 * at any given commit.
 *
 * Feature code in `apps/web/` should NOT call `window.vellum.*` directly.
 * Instead, wrap each persisted capability in a per-feature module under
 * `apps/web/src/runtime/` with named functions (see `native-biometric.ts`
 * for the established shape: `isBiometricEnabled()` / `setBiometricEnabled()`).
 * The module owns the cross-platform branch — `isElectron()` calls into
 * `window.vellum`, `isNativePlatform()` calls Capacitor, and the web branch
 * uses `localStorage` — so consumers stay platform-agnostic.
 */
// The lockfile bridge surface is typed against the contract owned by
// `@vellumai/local-mode` (the package the Electron main produces these values
// from), so the renderer never has to re-assert the shape with casts. The
// import is type-only and erased from the renderer bundle, and resolves the
// `/contract` entry point (dependency-free types + parser) so it never pulls
// the host's Node-only I/O graph into the renderer's module resolution.
import type { Lockfile, LockfileWriteResult } from "@vellumai/local-mode/contract";

/**
 * Renderer-side mirror of the discriminated union in
 * `apps/macos/src/main/commands.ts`. Inline (rather than cross-package
 * imported) because main, preload, and renderer each have their own TS
 * project; the type is tiny enough that maintaining identical literal
 * unions is cheaper than wiring cross-package imports.
 */
export type VellumCommand =
  | { kind: "newConversation" }
  | { kind: "currentConversation" }
  | { kind: "markCurrentUnread" }
  | { kind: "openSettings" }
  | { kind: "shareFeedback" }
  | { kind: "find" }
  | { kind: "markAllRead" }
  | { kind: "logout" }
  | { kind: "rePair" }
  | { kind: "sidebarToggle" }
  | { kind: "home" }
  | { kind: "popOut" }
  | { kind: "previousConversation" }
  | { kind: "nextConversation" }
  | { kind: "commandPalette" }
  | { kind: "openConversation"; conversationId: string }
  | { kind: "openLibrary" }
  | { kind: "openIdentity" }
  | { kind: "navigateBack" }
  | { kind: "navigateForward" }
  | { kind: "zoomIn" }
  | { kind: "zoomOut" }
  | { kind: "actualSize" }
  | { kind: "selectAssistant"; assistantId: string }
  | { kind: "createAssistant" }
  | { kind: "retireAssistant"; assistantId: string }
  | { kind: "quickInputSubmit"; message: string }
  | { kind: "cancelActiveAction" }
  | { kind: "replayOnboarding" }
  | { kind: "previewPrechat" }
  | { kind: "openComponentGallery" };

/**
 * Whether a hotkey is a system-wide global shortcut (active even when the app
 * is unfocused) or a focused-app menu accelerator. Renderer-side mirror of
 * `HotkeyScope` in `apps/macos/src/main/hotkeys.ts`.
 */
export type HotkeyScope = "global" | "menu";

/**
 * A rebindable command resolved against the current settings: the compiled
 * default, the user's override, and the effective accelerator. `override` is
 * `null` when the default is in use, `""` when the binding is disabled, or a
 * custom accelerator string. Renderer-side mirror of `ResolvedHotkey` in
 * `apps/macos/src/main/hotkeys.ts`.
 */
export interface ResolvedHotkey {
  key: string;
  label: string;
  scope: HotkeyScope;
  defaultAccelerator: string;
  override: string | null;
  accelerator: string;
  /**
   * Whether the user can rebind this command. `false` entries are reserved
   * accelerators (e.g. Find, Settings) carried only so the recorder can flag
   * conflicts against them; the page filters them out of the rendered rows.
   */
  rebindable: boolean;
}

/**
 * Renderer-side mirror of `AssistantStatus` in
 * `apps/macos/src/main/status.ts`. Inline for the same reason as
 * `VellumCommand` — main, preload, and renderer each have their own TS
 * project, and a tiny literal union is cheaper to mirror than to wire a
 * cross-package import. The five states map to the menu-bar status dot the
 * native app shows (`AppDelegate+MenuBar.swift`).
 */
export type AssistantStatus =
  | "idle"
  | "thinking"
  | "error"
  | "disconnected"
  | "authFailed";

/**
 * Renderer-side mirror of `ConnectivityState` in
 * `apps/macos/src/main/status.ts`. Inline for the same reason as
 * `AssistantStatus`. Main is the source of truth — it fuses device-level
 * online/offline and backend health-probe signals, then broadcasts to
 * all windows.
 */
export type ConnectivityState =
  | "online"
  | "device-offline"
  | "backend-unreachable";

export type HotkeyEventState = "down" | "up";

export interface HotkeyEvent {
  kind: "fnPushToTalk";
  state: HotkeyEventState;
}

export type FnPushToTalkResult =
  | { ok: true; enabled: boolean }
  | { ok: false; reason: string };

/**
 * Renderer-side mirror of `DictationPartialsResult` / `DictationPartialEvent`
 * in `apps/macos/src/main/hotkey-helper.ts` — inline for the same reason as
 * `VellumCommand`.
 */
export type DictationPartialsResult =
  | { ok: true; enabled: boolean }
  | { ok: false; reason: string };

export interface DictationPartialEvent {
  text: string;
}

/**
 * States the system-wide dictation overlay can display, plus the explicit
 * dismiss message. Renderer-side mirror of `DictationOverlayState` /
 * `DictationOverlayMessage` in
 * `apps/macos/src/main/dictation-overlay-window.ts` — inline for the same
 * reason as `VellumCommand`.
 */
export type DictationOverlayState =
  | { kind: "recording"; transcription: string; audioLevel?: number }
  | { kind: "processing" }
  | { kind: "done" }
  | { kind: "error"; message: string };

export type DictationOverlayMessage =
  | DictationOverlayState
  | { kind: "dismiss" };

/**
 * Renderer-side mirror of `TranscriptionOverlayState` in
 * `apps/macos/src/main/transcription-overlay-window.ts` — inline for the same
 * reason as `VellumCommand`.
 */
export interface TranscriptionOverlayState {
  transcript: string;
  createdAt: number;
  autoDismissMs: number;
}

export type HelperState =
  | { status: "idle" }
  | { status: "starting"; attempt: number }
  | { status: "running"; pid?: number }
  | {
      status: "backing-off";
      attempt: number;
      retryAt: number;
      reason: string;
    }
  | { status: "circuit-open"; reason: string }
  | { status: "stopped"; reason?: string };

export type HelperRestartResult =
  | { ok: true; state: HelperState }
  | { ok: false; reason: string; state: HelperState };

/**
 * Renderer-side mirror of `NotificationCategory` in
 * `apps/macos/src/main/notifications.ts`. Each variant maps to a set of
 * macOS action buttons (View, Approve/Reject, Open) that the Web
 * Notification API cannot provide.
 */
export type NotificationCategory =
  | "activityComplete"
  | "toolConfirmation"
  | "voiceResponseComplete"
  | "notificationIntent";

/**
 * Renderer → main payload for posting a native notification.
 * Mirror of `ShowNotificationPayload` in
 * `apps/macos/src/main/notifications.ts`.
 */
export interface ElectronShowNotificationPayload {
  category: NotificationCategory;
  title: string;
  body: string;
  deliveryId?: string;
  conversationId?: string;
  toolCallId?: string;
  deepLinkMetadata?: Record<string, unknown>;
}

export type ElectronTextInsertionResult =
  | { status: "inserted" }
  | { status: "vellum-focused" }
  | { status: "automation-denied" }
  | { status: "blocked" };

/**
 * Main → renderer event when the user interacts with a native
 * notification. Mirror of `NotificationActionEvent` in
 * `apps/macos/src/main/notifications.ts`.
 */
export interface ElectronNotificationActionEvent {
  kind: "click" | "action";
  category: NotificationCategory;
  actionIndex?: number;
  actionText?: string;
  deliveryId?: string;
  conversationId?: string;
  toolCallId?: string;
  deepLinkMetadata?: Record<string, unknown>;
}

/**
 * Renderer-side mirror of `BundleScanData` in
 * `apps/macos/src/main/bundle-manager.ts`. Inline for the same reason
 * as `VellumCommand` — main, preload, and renderer each have their
 * own TS project.
 */
export interface BundleScanData {
  manifest: {
    format_version: number;
    name: string;
    description?: string;
    icon?: string;
    entry: string;
    capabilities: string[];
    created_by: string;
    created_at: string;
  };
  scanResult: {
    passed: boolean;
    blocked: string[];
    warnings: string[];
  };
  signatureResult: {
    trustTier: "verified" | "signed" | "unsigned" | "tampered";
    signerKeyId?: string;
    signerDisplayName?: string;
    signerAccount?: string;
    message?: string;
  };
  bundleSizeBytes: number;
}

/**
 * Renderer-side mirror of `UpdateStatus` / `UpdateState` in
 * `apps/macos/src/main/auto-update.ts`. Inline for the same reason as
 * the other bridge types.
 */
export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  version?: string;
  progress?: { percent: number; transferred: number; total: number };
  error?: string;
}

declare global {
  interface Window {
    vellum?: {
      platform: "electron";
      app: {
        versionInfo(): Promise<{
          appName: string;
          version: string;
          commitSha: string;
          copyright: string;
          website: string;
        }>;
        openWebsite(): Promise<void>;
      };
      // Optional: older Electron shells predate the external text-insertion
      // bridge. Callers must guard on presence.
      text?: {
        insertIntoFrontApp(text: string): Promise<ElectronTextInsertionResult>;
        openAutomationSettings(): Promise<void>;
      };
      // Optional: an older preload predates the hotkeys/featureFlags channels.
      // The macOS app and web bundle don't release together, so a newer
      // renderer can run against an older preload; callers must guard on
      // presence (see `status`/`icon` below for the same pattern).
      hotkeys?: {
        get(): Promise<ResolvedHotkey[]>;
        set(key: string, accelerator: string | null): Promise<void>;
        onChange(callback: (catalog: ResolvedHotkey[]) => void): () => void;
      };
      featureFlags?: {
        set(flags: Record<string, boolean>): void;
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
        // Optional: older Electron shells predate the dictation channel.
        dictation?: {
          setPartials(enable: boolean): Promise<DictationPartialsResult>;
          onPartial(
            callback: (event: DictationPartialEvent) => void,
          ): () => void;
        };
      };
      commands: {
        on(callback: (command: VellumCommand) => void): () => void;
      };
      // Optional: older Electron shells predate the status/icon channels. The
      // macOS app and web bundle don't release together, so a newer renderer
      // can run against an older preload; callers must guard on presence.
      status?: {
        setConnection(status: AssistantStatus): void;
      };
      icon?: {
        setAvatar(png: Uint8Array | null): void;
      };
      dock: {
        setBadge(count: number): void;
        setSignedIn(signedIn: boolean): void;
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
        ): Promise<LockfileWriteResult>;
        retire(assistantId: string): Promise<{ ok: boolean; error?: string }>;
        // Optional: older Electron shells predate the wake IPC channel. The
        // macOS app and web bundle don't release together, so a newer renderer
        // can run against an older preload; callers must guard on its presence.
        wake?(assistantId: string): Promise<{ ok: boolean; error?: string }>;
        guardianToken(
          assistantId: string,
        ): Promise<
          | { ok: true; accessToken: string }
          | { ok: false; status: number; error: string }
        >;
      };
      // Optional: older Electron shells predate the native OAuth IPC channel.
      auth?: {
        startOAuth(options: {
          providerHint?: string;
          loginHint?: string;
          intent?: string;
        }): Promise<{ sessionToken: string }>;
        cancelOAuth(): Promise<void>;
        // Optional: older shells predate the session-token bridge.
        getSessionToken?(): string | null;
        signOut?(): Promise<void>;
      };
      mainWindow: {
        ensureVisible(): Promise<void>;
        setOnboarding(active: boolean): Promise<void>;
      };
      power: {
        onEvent(
          callback: (event: {
            kind: "suspend" | "resume" | "lock" | "unlock" | "active";
          }) => void,
        ): () => void;
      };
      deepLinks: {
        drain(): Promise<
          Array<
            | { kind: "send"; message: string }
            | { kind: "openThread"; threadId: string }
            | { kind: "unknown"; url: string }
          >
        >;
        onLink(
          callback: (
            link:
              | { kind: "send"; message: string }
              | { kind: "openThread"; threadId: string }
              | { kind: "unknown"; url: string },
          ) => void,
        ): () => void;
      };
      feedback?: {
        diagnostics(): Promise<Record<string, unknown>>;
        logs(): Promise<string>;
      };
      // Optional: older Electron shells predate the connectivity channel.
      connectivity?: {
        onState(
          callback: (state: ConnectivityState) => void,
        ): () => void;
        setDevice(online: boolean): void;
        retry(): void;
      };
      // Optional: older Electron shells predate the quick input channel.
      quickInput?: {
        submit(message: string): Promise<void>;
        dismiss(): Promise<void>;
      };
      // Optional: older Electron shells predate the standalone command palette
      // window channel. Fall back to the in-page palette when absent.
      commandPalette?: {
        open(): Promise<void>;
        dismiss(): Promise<void>;
        select(command: VellumCommand): Promise<void>;
      };
      // Optional: older Electron shells predate the dictation overlay channel.
      dictationOverlay?: {
        setState(state: DictationOverlayMessage): void;
        onState(
          callback: (state: DictationOverlayState) => void,
        ): () => void;
        getState(): Promise<DictationOverlayState | null>;
      };
      // Optional: older Electron shells predate the final transcription
      // overlay channel.
      transcriptionOverlay?: {
        show(state: TranscriptionOverlayState): Promise<void>;
        dismiss(): Promise<void>;
        onState(
          callback: (state: TranscriptionOverlayState) => void,
        ): () => void;
        getState(): Promise<TranscriptionOverlayState | null>;
      };
      // Optional: older Electron shells predate the notifications channel.
      notifications?: {
        show(
          payload: ElectronShowNotificationPayload,
        ): Promise<{ success: boolean; errorMessage?: string }>;
        onAction(
          callback: (event: ElectronNotificationActionEvent) => void,
        ): () => void;
      };
      // Optional: older Electron shells predate the popout channel.
      popout?: {
        open(conversationId: string): Promise<void>;
      };
      // Optional: older Electron shells predate the bundleConfirm channel.
      bundleConfirm?: {
        getData(): Promise<BundleScanData | null>;
        respond(accepted: boolean): void;
      };
      // Optional: older Electron shells predate the auto-update channel.
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
