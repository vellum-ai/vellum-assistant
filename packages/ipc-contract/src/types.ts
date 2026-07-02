/**
 * Shared payload types for the Electron bridge IPC surface.
 *
 * Every type in this file was previously maintained as an identical literal
 * copy in three separate TS projects (main, preload, renderer). This package
 * is the single source of truth — consumers import types from here instead
 * of re-declaring them inline.
 *
 * Conventions:
 *   - Types that main validates at the IPC boundary have a companion Zod
 *     schema in `./schemas.ts`; the type here is the canonical definition
 *     and the schema mirrors it (not the other way around) because most
 *     types flow main→renderer and are never validated by the receiver.
 *   - Names use the main-process convention (no `Electron` prefix).
 *     The renderer previously prefixed some types (`ElectronShowNotificationPayload`
 *     etc.); those are retired by this package.
 */

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Discriminated union of every app command. Main dispatches these to the
 * focused renderer window via `vellum:command` IPC; the renderer routes
 * them through the event bus.
 */
export type VellumCommand =
  | { kind: "newConversation" }
  | { kind: "currentConversation" }
  | { kind: "markCurrentUnread" }
  | { kind: "openSettings" }
  | { kind: "shareFeedback" }
  | { kind: "find" }
  | { kind: "markAllRead" }
  | { kind: "login" }
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
  | { kind: "chooseAssistant" }
  | { kind: "createAssistant" }
  | { kind: "retireAssistant"; assistantId: string }
  | { kind: "quickInputSubmit"; message: string }
  | { kind: "cancelDictation" }
  | { kind: "replayOnboarding" }
  | { kind: "previewPrechat" }
  | { kind: "replayHatchFailure" }
  | { kind: "openComponentGallery" };

// ---------------------------------------------------------------------------
// Hotkeys
// ---------------------------------------------------------------------------

/** Global (system-wide) vs menu (app-focused) shortcut scope. */
export type HotkeyScope = "global" | "menu";

/**
 * A rebindable command resolved against the current settings: compiled
 * default, user override (if any), and effective accelerator.
 *
 * `override` is `null` when using the default, `""` when explicitly
 * disabled, or a custom accelerator string.
 */
export interface ResolvedHotkey {
  key: string;
  label: string;
  scope: HotkeyScope;
  defaultAccelerator: string;
  override: string | null;
  accelerator: string;
  /**
   * Whether the user can rebind this command from the settings UI.
   * `false` entries are reserved accelerators included only so the
   * recorder can detect conflicts; the page does not render a row.
   */
  rebindable: boolean;
}

export type HotkeyEventState = "down" | "up";

export interface HotkeyEvent {
  kind: "fnPushToTalk";
  state: HotkeyEventState;
}

export type FnPushToTalkResult =
  | { ok: true; enabled: boolean }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// System permissions
// ---------------------------------------------------------------------------

export const SYSTEM_PERMISSION_KINDS = [
  "accessibility",
  "screen",
  "microphone",
  "speechRecognition",
  "inputMonitoring",
  "automation",
  "notifications",
] as const;

export type SystemPermissionKind = (typeof SYSTEM_PERMISSION_KINDS)[number];

export const SYSTEM_PERMISSION_STATUSES = [
  "unknown",
  "restricted",
  "denied",
  "not-determined",
  "granted",
] as const;

export type SystemPermissionStatus =
  (typeof SYSTEM_PERMISSION_STATUSES)[number];

export interface SystemPermissionStateItem {
  kind: SystemPermissionKind;
  status: SystemPermissionStatus;
  canRequest: boolean;
  canOpenSettings: boolean;
  requiresRestart: boolean;
  error?: string;
}

export type SystemPermissionsState = Record<
  SystemPermissionKind,
  SystemPermissionStateItem
>;

// ---------------------------------------------------------------------------
// Status & connectivity
// ---------------------------------------------------------------------------

/**
 * Assistant connection status driving the menu-bar (Tray) indicator.
 * Mirrors the Swift app's `AssistantStatus` enum — same five states,
 * same colors, same "thinking pulses" behavior.
 */
export const ASSISTANT_STATUSES = [
  "idle",
  "thinking",
  "error",
  "disconnected",
  "authFailed",
] as const;

export type AssistantStatus = (typeof ASSISTANT_STATUSES)[number];

export const CONNECTIVITY_STATES = [
  "online",
  "device-offline",
  "backend-unreachable",
] as const;

export type ConnectivityState = (typeof CONNECTIVITY_STATES)[number];

// ---------------------------------------------------------------------------
// Power events
// ---------------------------------------------------------------------------

export type PowerEventKind =
  | "suspend"
  | "resume"
  | "lock"
  | "unlock"
  | "active";

export interface PowerEvent {
  kind: PowerEventKind;
}

// ---------------------------------------------------------------------------
// Deep links
// ---------------------------------------------------------------------------

/**
 * Typed deep-link variants parsed from `vellum://` and
 * `vellum-assistant://` URL schemes.
 *
 * `authCallback` is intentionally omitted — it is intercepted in main
 * before the bridge and never reaches the renderer.
 */
export type DeepLink =
  | { kind: "send"; message: string }
  | { kind: "openThread"; threadId: string }
  | { kind: "unknown"; url: string };

// ---------------------------------------------------------------------------
// Dictation
// ---------------------------------------------------------------------------

export type DictationPartialsResult =
  | { ok: true; enabled: boolean }
  | { ok: false; reason: string };

export interface DictationPartialEvent {
  text: string;
}

/**
 * States the system-wide dictation overlay can display.
 * `dismiss` is a control message, not a display state.
 */
export type DictationOverlayState =
  | { kind: "recording"; transcription: string; audioLevel?: number }
  | { kind: "processing" }
  | { kind: "done" }
  | { kind: "error"; message: string };

export type DictationOverlayMessage =
  | DictationOverlayState
  | { kind: "dismiss" };

// ---------------------------------------------------------------------------
// Helper (native sidecar process)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const NOTIFICATION_CATEGORIES = [
  "activityComplete",
  "toolConfirmation",
  "voiceResponseComplete",
  "notificationIntent",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Renderer → main payload for posting a native notification. */
export interface ShowNotificationPayload {
  category: NotificationCategory;
  title: string;
  body: string;
  deliveryId?: string;
  conversationId?: string;
  toolCallId?: string;
  deepLinkMetadata?: Record<string, unknown>;
}

export type TextInsertionResult =
  | { status: "inserted" }
  | { status: "vellum-focused" }
  | { status: "automation-denied" }
  | { status: "blocked" };

/** Main → renderer event when the user interacts with a notification. */
export interface NotificationActionEvent {
  kind: "click" | "action";
  category: NotificationCategory;
  actionIndex?: number;
  actionText?: string;
  deliveryId?: string;
  conversationId?: string;
  toolCallId?: string;
  deepLinkMetadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Auto-update
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// About / version info
// ---------------------------------------------------------------------------

export interface AppVersionInfo {
  appName: string;
  version: string;
  commitSha: string;
  copyright: string;
  website: string;
}

// ---------------------------------------------------------------------------
// Lockfile (bridge-facing subset of @vellumai/local-mode/contract)
// ---------------------------------------------------------------------------

/**
 * Shape of the lockfile as returned across the Electron bridge.
 *
 * Matches the canonical `Lockfile` / `LockfileWriteResult` types in
 * `@vellumai/local-mode/contract`. Declared here so the contract package
 * has no `file:` dependency on local-mode (which carries a transitive
 * `file:` chain to `@vellumai/environments` that breaks lockfile
 * resolution in consumer packages).
 */

export interface LocalAssistantResources {
  instanceDir?: string;
  gatewayPort: number;
  daemonPort: number;
  runtimeVersion?: string;
  runtimeInstallDir?: string;
}

export interface LockfileAssistant {
  assistantId: string;
  name?: string;
  cloud?: string;
  runtimeUrl?: string;
  species?: string;
  hatchedAt?: string;
  organizationId?: string;
  platformAssistantId?: string;
  platformBaseUrl?: string;
  platformOrganizationId?: string;
  resources?: LocalAssistantResources;
}

export interface Lockfile {
  assistants: LockfileAssistant[];
  activeAssistant: string | null;
}

export type LockfileWriteResult =
  | { ok: true; lockfile: Lockfile }
  | { ok: false; error: string };

export type LocalAssistantRuntimeState =
  | "healthy"
  | "upgrading"
  | "sleeping"
  | "starting"
  | "crashed"
  | "unknown";

export type LocalAssistantStatusResult =
  | {
      ok: true;
      state: LocalAssistantRuntimeState;
      detail?: string;
      pid?: number;
    }
  | { ok: false; status: number; error: string };
