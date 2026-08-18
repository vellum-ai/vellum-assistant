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
  | { kind: "removePairedAssistant"; assistantId: string }
  | { kind: "quickInputSubmit"; message: string }
  /**
   * Start a live-voice session, the way the companion surface's Talk asks for
   * one.
   *
   * Carries no conversation: the session starts against a draft and the server
   * assigns the conversation on its `ready` frame, which is the same shape the
   * `startVoice` deep link uses. A press that lands while a session is already
   * running is a no-op, because the running session is the one the user is in.
   */
  | { kind: "startVoice" }
  /**
   * Send what the user typed on the companion surface, the way its Type option
   * asks.
   *
   * **The surface has its own thread.** Opening the composer starts a
   * conversation and every follow-up continues it, rather than sending into
   * whatever the app happens to have selected: the user reached past the app to
   * a floating avatar, so they are starting something, not resuming a thread
   * they cannot see. `startsConversation` marks the first message of a
   * composer's life; the rest land in the conversation that one created, which
   * is the app's active one by then.
   *
   * Like `startVoice`, this does not raise the app. The user reached for a
   * floating surface precisely because they are working somewhere else.
   */
  | {
      kind: "companionSubmit";
      message: string;
      startsConversation: boolean;
    }
  | { kind: "cancelDictation" }
  | { kind: "replayOnboarding" }
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
  { ok: true; enabled: boolean } | { ok: false; reason: string };

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
  "suspend" | "resume" | "lock" | "unlock" | "active";

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
  /**
   * `flow` distinguishes a Pro subscription checkout from a credit top-up
   * checkout. The main-process parser always sets it, defaulting to
   * `subscription` when the link omits the `flow` query param (all current
   * Pro links). Optional at this seam because a newer renderer can pair
   * with a main process that predates the field (dev serves the SPA from
   * Vite or the edge proxy, not the app bundle); the renderer defaults an
   * absent value to `subscription`.
   */
  | {
      kind: "billingCheckoutComplete";
      status: "success";
      sessionId: string;
      flow?: "subscription" | "top_up";
    }
  | {
      kind: "billingCheckoutComplete";
      status: "cancel";
      sessionId: null;
      flow?: "subscription" | "top_up";
    }
  /**
   * `<scheme>://connect`: the pair-page "Open in the Vellum app" hand-off
   * and `vellum pair --qr --app` QR codes. `url` is a validated https server
   * base; `bundle` (pairing bundle) is secret material and must never be
   * logged or breadcrumbed. Fields absent when their query params were
   * missing or malformed. The link never carries the `code` query param
   * (device code): the renderer has no consumer for it.
   */
  | { kind: "connect"; url?: string; bundle?: string }
  | { kind: "unknown"; url: string };

// ---------------------------------------------------------------------------
// Dictation
// ---------------------------------------------------------------------------

export type DictationPartialsResult =
  { ok: true; enabled: boolean } | { ok: false; reason: string };

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
  DictationOverlayState | { kind: "dismiss" };

// ---------------------------------------------------------------------------
// Voice activity (the floating live-voice session surface)
// ---------------------------------------------------------------------------

/**
 * Phases of a *running* live-voice session, as the floating surface renders
 * them.
 *
 * Mirrors the web layer's `ActiveLiveVoiceSessionState`: the phases a session
 * has while it exists, so neither `idle` (no session) nor `failed` (which ends
 * the surface rather than rendering as a phase) appears here. The two are kept
 * in step structurally rather than by import: the mirror hands its own payload
 * to this channel, so a phase added there without a case here fails to compile
 * at that call site.
 *
 * The same vocabulary is decoded on iOS by
 * `VoiceSessionAttributes.ContentState.Phase`. This surface and that one are
 * two renderings of one contract.
 */
export const VOICE_ACTIVITY_PHASES = [
  "connecting",
  "listening",
  "transcribing",
  "thinking",
  "speaking",
  "ending",
] as const;

export type VoiceActivityPhase = (typeof VOICE_ACTIVITY_PHASES)[number];

/** The mutable half of the surface: everything that can change mid-session. */
export interface VoiceActivityContent {
  phase: VoiceActivityPhase;
  /**
   * User-facing phase copy, passed through from the web layer verbatim
   * (`liveVoiceSurfaceLabel`), so the surface shows exactly what the voice room
   * shows. Main and the surface own no phase wording of their own. The wording
   * deploys continuously with the web bundle while the shell ships on release
   * cadence, so a `switch` over `phase` on this side would fossilize.
   */
  label: string;
  /** Avatar accent as `#RRGGBB`, or `""` when the avatar has no color yet. */
  accentHex: string;
  muted: boolean;
  /** Whether the assistant's audio is muted: what the speaker button renders against. */
  outputMuted: boolean;
  /** One short line describing what the turn is doing ("Reading a file"), or `""`. */
  detail: string;
  /**
   * The confirmation the turn is waiting on, or `""` when it is waiting on
   * none. Non-empty is what puts Approve/Deny on the surface, and the id travels
   * with them so a decision answers the request the user was shown.
   */
  approvalRequestId: string;
}

/** {@link VoiceActivityContent} plus the fields fixed for the session's lifetime. */
export interface VoiceActivityStart extends VoiceActivityContent {
  assistantName: string;
  /**
   * The assistant's avatar as a base64 PNG or JPEG. Omitted when there is
   * none, which the surface renders as its accent glyph instead.
   *
   * Sent once at `start` and never re-sent: it cannot change while a session
   * runs, and it is the one field in this payload big enough for re-sending to
   * be worth avoiding.
   */
  avatarBase64?: string;
}

/**
 * What the surface's own renderer receives: everything the session sent, plus
 * `startedAt`, which main stamps.
 *
 * `startedAt` is main's rather than the sender's because the surface is a
 * separate renderer that can load, reload, or be recreated mid-session, and an
 * elapsed clock anchored in either renderer would restart when that happened.
 */
export interface VoiceActivityState extends VoiceActivityStart {
  /** Epoch ms when main first saw this session. */
  startedAt: number;
}

/**
 * What a control on the session surface asks of the session.
 *
 * Each mute is **absolute: the state the button's own label promised**, not
 * a toggle. The surface renders content that can be a beat old, so a toggle
 * resolved against live session state is self-consistent and still wrong for
 * the user: a button reading "Mute assistant" over an already-muted session
 * would unmute it. Sending what the button said makes that press a no-op,
 * which the next push corrects.
 *
 * Mirrors `VoiceSessionControlAction` on iOS and the web layer's
 * `VoiceLiveActivityControlAction`; all three are one vocabulary.
 */
export const VOICE_ACTIVITY_CONTROL_ACTIONS = [
  "muteMicrophone",
  "unmuteMicrophone",
  "muteAssistantAudio",
  "unmuteAssistantAudio",
  "endSession",
  "approveRequest",
  "denyRequest",
] as const;

export type VoiceActivityControlAction =
  (typeof VOICE_ACTIVITY_CONTROL_ACTIONS)[number];

export interface VoiceActivityControl {
  action: VoiceActivityControlAction;
  /**
   * The confirmation an `approveRequest` / `denyRequest` press was drawn
   * against; absent on every other action.
   *
   * The absolute-mute principle carried one step further. A mute that arrives
   * stale is a no-op the next push corrects; an approval that arrived stale
   * would answer a *different question* than the one the user was shown. The
   * request it named may since have been decided in the main window or timed
   * out. So the press names its request, and the session answers that one or
   * drops the press.
   */
  requestId?: string;
}

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
  "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";

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
  { ok: true; lockfile: Lockfile } | { ok: false; error: string };

export type LocalAssistantRuntimeState =
  | "healthy"
  /** Alive and serving, but DB migrations failed — restart to recover. */
  | "unhealthy"
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

// ---------------------------------------------------------------------------
// Companion surface
// ---------------------------------------------------------------------------

/**
 * Which way the companion pill grows out of the avatar, which holds its place.
 *
 * `right` is the shape the surface is designed around; `left` is what it
 * degrades to when the right edge of the display is closer than the pill's
 * widest state needs. Main decides: it owns the window position and is the only
 * side that knows which display the surface is on.
 *
 * The avatar does not move either way. That is the whole point of naming a
 * *direction* rather than an anchor: the mascot is the fixed thing the user
 * aims at, and the pill is what changes shape around it.
 */
export const COMPANION_GROWTHS = ["right", "left"] as const;

export type CompanionGrowth = (typeof COMPANION_GROWTHS)[number];

/**
 * The assistant's character, as the three trait ids it is composed from.
 *
 * Structurally the fields of the web layer's `CharacterTraits` that
 * `composeSvg` actually consumes, restated here rather than imported: that type
 * is generated from the daemon's OpenAPI schema, and the contract package must
 * not depend on it.
 *
 * Traits rather than pixels, because the surface renders the *live* character
 * from them: an avatar that blinks and breathes cannot be shipped as a still.
 * Absent for an assistant whose avatar is a custom uploaded image, which has no
 * traits to compose from and stays a still.
 */
export interface CompanionCharacter {
  bodyShape: string;
  eyeStyle: string;
  color: string;
}

/**
 * One side of one exchange, condensed for the companion surface's card.
 *
 * Text and a side, and nothing else: no ids, no attachments, no tool calls, no
 * surfaces. The card is a glance at where the conversation got to, so anything
 * richer crossing this bridge would be an invitation to render a transcript on
 * a surface floating over someone else's work.
 */
export interface CompanionTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * What the app's own window knows that the surface cannot.
 *
 * The surface is a renderer with no assistant and no conversation in it, so
 * both facts are published by the window that has them. One payload rather than
 * two channels: they describe the same assistant at the same moment, and a
 * surface drawing one assistant's name over another's words is exactly the skew
 * two independently-pushed facts would produce.
 */
export interface CompanionContext {
  /**
   * The assistant's display name, already resolved: the surface renders it
   * verbatim rather than deciding what an unnamed assistant is called.
   */
  assistantName: string;
  /** The conversation's tail, most recent last. */
  turns: CompanionTurn[];
}

/** What main tells the companion renderer. */
export interface CompanionSurfaceState {
  growth: CompanionGrowth;
  /**
   * The assistant's display name, for the composer's placeholder.
   *
   * Empty until the app's window publishes one, which the surface reads as
   * "not known yet" and covers with its own fallback wording.
   */
  assistantName: string;
  /**
   * The tail of the conversation the surface belongs to, most recent last, or
   * empty when there is none to show.
   *
   * Published by the renderer that owns the conversation and held here for the
   * same reason the session is: the surface's own renderer can reload, and a
   * card that came back blank would read as the conversation having been lost.
   * It is what lets an exchange started from Type be read without going back to
   * the app at all.
   */
  turns: CompanionTurn[];
  /**
   * The character to render live, or `undefined` when there is none to
   * compose. See {@link CompanionCharacter}; `avatarBase64` is the fallback.
   */
  character?: CompanionCharacter;
  /**
   * The live-voice session the surface is showing, or `null` when none is
   * running.
   *
   * This is what makes the companion the desktop's session surface rather than
   * a launcher for one: while it is set the pill holds its expanded call state
   * whether or not the pointer is anywhere near it, because a live microphone
   * that only shows itself on hover is a live microphone the user cannot see.
   */
  call: VoiceActivityState | null;
  /**
   * The assistant's avatar as a base64 PNG, or `undefined` when there is none.
   *
   * Reuses the cache main already keeps for the Dock and Tray icons, which the
   * renderer publishes over `vellum:icon:setAvatar`. One avatar feeds every
   * surface, so the companion cannot drift from the icon in the Dock beside it.
   */
  avatarBase64?: string;
}
