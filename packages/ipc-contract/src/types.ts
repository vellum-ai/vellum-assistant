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
  /**
   * Pin the conversation the user is looking at, or unpin it when it is
   * already pinned. One kind for both edges because the renderer owns the
   * pinned state; main builds a single static menu item and never learns
   * which edge a press is.
   */
  | { kind: "togglePinConversation" }
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
   * Turn a watch session on or off, the way the companion surface's Watch
   * option asks.
   *
   * One command for both edges rather than a start and a stop: the surface
   * draws a single toggle, and the window that owns the session is the only
   * side that knows which edge a press is. A press that lands while a session
   * is running ends that session.
   *
   * Like `startVoice`, this does not raise the app. The user reached for a
   * floating surface precisely because they are working somewhere else, and
   * here that work is the subject: raising the app would cover the very thing
   * the session exists to observe.
   */
  | { kind: "toggleWatch" }
  /**
   * Answer the question the surface asks once a watch session's summary is
   * written: open it now, or not.
   *
   * `open: true` is the one press on this surface that deliberately raises the
   * app, and it is the exception `toggleWatch` above explains: the session is
   * over, so there is no longer any work of the user's for Vellum to cover, and
   * a "show me" that left the report where it was would be a promise the
   * surface cannot keep.
   *
   * `open: false` still travels rather than being handled where it was pressed.
   * The window that holds the session holds the question too, and a dismissal
   * the surface kept to itself would leave that window waiting on an answer
   * that already happened, ready to redraw the prompt on the next push.
   */
  | { kind: "answerWatchRetro"; open: boolean }
  /**
   * Start a live-voice session, or end the one that is running.
   *
   * The keyboard's version of Talk. It differs from `startVoice` in the one
   * way a key differs from a button: the same press has to undo itself,
   * because a global shortcut is often the only voice control within reach of
   * someone working in another app. Talk stays start-only, since the surface
   * that draws it also draws a way to stop.
   */
  | { kind: "toggleVoice" }
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
  "not-applicable",
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
// Downloads
// ---------------------------------------------------------------------------

/**
 * Terminal report for one renderer-initiated download, pushed to the
 * originating window. `id` is an opaque main-process token: the renderer
 * hands it back to `downloads.reveal` and main resolves it to the saved
 * path itself, so no filesystem path ever travels renderer-to-main.
 * `id` is only present when `state` is `"completed"`: an interrupted
 * download has no file to reveal.
 */
export interface DownloadDoneEvent {
  id?: string;
  filename: string;
  state: "completed" | "interrupted";
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
   * and `vellum pair --app` QR codes. `url` is a validated https server
   * base and `code` the device code it carries, which the local-mode host
   * exchanges for pairing credentials. `code` is credential material and
   * must never be logged or breadcrumbed; it rides only alongside a usable
   * `url`. `legacy` marks a link that carried a `bundle` param from an app
   * version whose connect dialog took a pasted pairing bundle: only the
   * presence crosses this seam, never the payload. Fields absent when
   * their query params were missing or malformed.
   */
  | { kind: "connect"; url?: string; code?: string; legacy?: true }
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

export interface DictationTranscribeResult {
  ok: boolean;
  reason?: string;
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

/**
 * Where the overlay's Stop control sits, in window-relative CSS pixels.
 * The overlay renderer reports it so main can hit-test the cursor against
 * it on platforms where forwarded mouse moves never reach a click-through
 * window.
 */
export type DictationOverlayHitRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

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
   * User-facing phase copy, passed through from the web layer verbatim: the
   * web resolves `liveVoiceSurfaceLabelKey` through its own catalog, so the
   * surface shows exactly what the voice room shows, in the language the app is
   * in. Main and the surface own no phase wording of their own. The wording
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
 * What the surface's own renderer receives, which is exactly what the session
 * sent.
 *
 * The same shape as {@link VoiceActivityStart} under a name that says which end
 * is holding it: a `start` is an event a renderer publishes, and this is the
 * session main keeps and pushes down. Main once added `startedAt` here to
 * anchor an elapsed clock outside a renderer that can reload mid-session, and
 * dropped it with the clock (JARVIS-1546): a timestamp nothing reads is a
 * timestamp that quietly rots.
 */
export type VoiceActivityState = VoiceActivityStart;

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
 * Which way the typing card grows out of the composer row, which holds the line
 * the pill occupied.
 *
 * The vertical half of {@link CompanionGrowth}, decided the same way and for a
 * sharper reason. macOS refuses to place a window frame above the top of the
 * work area, so the canvas cannot hang off the top of the display the way it
 * hangs off the bottom. With the avatar pinned to the canvas's centre the
 * avatar could therefore never get closer to the top of the screen than half
 * the canvas, which fences it out of the top of the display entirely.
 *
 * So the avatar's offset inside the canvas is not fixed: `up` puts it low in
 * the canvas with the card's height reserved above it, `down` puts it high with
 * that height reserved below. Main picks from the room the display actually
 * has, and the avatar still does not move: the canvas moves around it.
 *
 * `up` is the shape the surface is designed around, since it lives by the Dock
 * where a card growing downward would grow off the bottom of the screen.
 */
export const COMPANION_CARD_GROWTHS = ["up", "down"] as const;

export type CompanionCardGrowth = (typeof COMPANION_CARD_GROWTHS)[number];

/**
 * How big the companion is drawn, as a named step rather than a number.
 *
 * Named rather than free, because the avatar's box is not a style: it is the
 * geometry both sides of the bridge agree on, and everything derives from it:
 * the pill's reach, the card's height, and the canvas sized to hold the largest
 * state. A continuous scale would be a layout nobody had ever looked at; five
 * steps are five layouts, each checkable in Storybook.
 *
 * `medium` is the default. Every length on the surface is stated at 44 points
 * and scaled from there, and which named step that is depends on the axis: it
 * is `small` on the avatar's table and `medium` on the options' (see
 * {@link COMPANION_OPTIONS_SIZE_BOXES}). `ridiculous` is the joke at the end of
 * the scale, and it is a real step rather than a gag drawn some other way: the
 * largest step costs one number per table and is drawn by the same code as the
 * other four.
 */
export const COMPANION_SIZES = [
  "small",
  "medium",
  "large",
  "huge",
  "ridiculous",
] as const;

export type CompanionSize = (typeof COMPANION_SIZES)[number];

/** The avatar's box in points, per named size. The scale is this over `small`. */
export const COMPANION_AVATAR_SIZE_BOXES: Record<CompanionSize, number> = {
  small: 44,
  medium: 66,
  large: 88,
  huge: 110,
  // Five times the authored size, which puts the canvas well past the width of
  // any display it will be shown on. That is allowed: a canvas may hang off the
  // left and right freely, and the card flips to growing downward when the
  // display is too short for it, so the oversize step lands on paths the other
  // four already take near an edge.
  ridiculous: 220,
};

/**
 * The options pill's box in points, per named size.
 *
 * One notch below the creature's table at every step, because a control strip
 * and a mascot are not read at the same size: the creature is a character on
 * the desktop and wants to be seen, and the pill is a row of controls that
 * wants to be reachable. The same name on both axes should leave the pill
 * comfortably shorter than the creature holding it out.
 *
 * The pill is authored at 44 and {@link companionScaleFor} still divides by
 * {@link COMPANION_BASE_AVATAR_BOX}, so these are scales of that one layout:
 * `small` is that layout at 32/44 and `medium` is it at 1:1. Nothing here is a
 * second set of dimensions, which is what keeps the five steps five drawings of
 * the same surface.
 */
export const COMPANION_OPTIONS_SIZE_BOXES: Record<CompanionSize, number> = {
  small: 32,
  medium: 44,
  large: 66,
  huge: 88,
  ridiculous: 110,
};

/**
 * What the surface is drawn at when nothing has been chosen.
 *
 * The second step rather than the third. The companion arrives on the desktop
 * without anyone having asked for it, over whatever the user was already
 * working in, so it arrives at the size of an uninvited guest: big enough to be
 * recognised as the creature it is, small enough that nobody has to move it
 * before they can carry on. The steps above are for the users who then want it
 * bigger, and the introduction's last beat is where they are told to find
 * them (see {@link COMPANION_INTRO_BEATS}).
 */
export const DEFAULT_COMPANION_SIZE: CompanionSize = "medium";

/**
 * The two things on the surface a user sizes, sized separately.
 *
 * An avatar big enough to read from across the room does not mean a pill that
 * wide, and both axes take the same five names ({@link COMPANION_SIZES}), so
 * there is one vocabulary and two answers rather than two scales to learn. Each
 * axis reads its own table, since the same name means a different box on each.
 * `avatar` sizes the creature, its glow and its bob; `options` sizes the pill,
 * the typing card, the call's body and the introduction's card.
 */
export const COMPANION_SIZE_AXES = ["avatar", "options"] as const;

export type CompanionSizeAxis = (typeof COMPANION_SIZE_AXES)[number];

/**
 * The box one axis draws a named size at.
 *
 * The one place a name becomes a number, so nothing downstream has to remember
 * which of the two tables its axis reads. Names are what the menus offer and
 * what the store keeps; boxes are what the geometry is done in.
 */
export const companionBoxFor = (
  axis: CompanionSizeAxis,
  size: CompanionSize,
): number =>
  axis === "avatar"
    ? COMPANION_AVATAR_SIZE_BOXES[size]
    : COMPANION_OPTIONS_SIZE_BOXES[size];

/**
 * The avatar's box the companion's layout is authored at, and the size every
 * other length in that layout is stated in.
 *
 * The scale is the box in either size table over this one. The renderer draws
 * at this size and scales the whole surface by that factor, so the two
 * processes never hold two sets of dimensions.
 */
export const COMPANION_BASE_AVATAR_BOX = COMPANION_AVATAR_SIZE_BOXES.small;

/**
 * The creature's artwork inside that box, which is inset on every side.
 *
 * The visible creature rather than the box around it. The box is bigger than
 * the drawing so the glow has somewhere to fall off into and the bob has
 * somewhere to rise into, and `CompanionSurface` draws both the still and the
 * composed avatar at this size so nothing moves when one replaces the other.
 */
export const COMPANION_BASE_AVATAR_IMAGE = 28;

/**
 * Room the pill's shadow and the avatar's glow paint outside their own boxes,
 * at the base size.
 */
export const COMPANION_BASE_CANVAS_PAD = 24;

/**
 * The tallest the surface draws at the base size, which is the typing card.
 *
 * Every other state is a pill exactly {@link COMPANION_BASE_AVATAR_BOX} tall.
 * The card stacks the conversation above that row in a viewport that scrolls
 * once it is full, so it has a ceiling rather than growing with the exchange,
 * and this is that ceiling rounded up: the card's text is laid out in the
 * renderer, and a canvas a few points short clips the top of it off.
 *
 * Matched to `CompanionSurface`'s card, and held here rather than beside the
 * placement rules because {@link companionCardSideFor} sizes the canvas from
 * it.
 */
export const COMPANION_BASE_CARD_HEIGHT = 290;

/**
 * The widest the pill draws at the base size, measured from its avatar-facing
 * edge.
 *
 * An outer width, padding included: the renderer draws a pill as its measured
 * body plus its own clearance at either end, and that whole width is what has
 * to fit. The typing card is exactly this wide, being the one state that states
 * a width rather than measuring one.
 *
 * A ceiling rather than a width, since every other state is as wide as its
 * content. Main sizes the canvas to hold this much beyond the gap, so a state
 * that wanted more would be clipped by the window.
 */
export const COMPANION_BASE_MAX_PILL_WIDTH = 316;

/**
 * The room between the avatar's edge and the options pill beside it, at the
 * base size.
 *
 * A gap rather than a shared edge. The avatar is a creature standing on the
 * desktop and the pill is what it is holding out, so the two read as one
 * surface by sitting near each other rather than by being fused into a single
 * outline. It is also what gives the glow somewhere to fall off into, instead
 * of ending against the pill's border.
 */
export const COMPANION_BASE_GAP = 12;

/**
 * The scale a box is drawn at: the box over the size the layout is authored at.
 *
 * The one conversion from points into the units every length on the surface is
 * stated in, so neither side of the bridge divides by the base box on its own.
 */
export const companionScaleFor = (box: number): number =>
  box / COMPANION_BASE_AVATAR_BOX;

/**
 * How far below the avatar's centre the pill's bottom sits, for a given avatar
 * box.
 *
 * The creature's visible bottom rather than its box's. The box runs past the
 * artwork on every side to hold the glow and the bob's slack, so a pill lined
 * up with the box reads as sitting below the creature rather than beside it.
 * The bob lifts the creature off this line and returns to it, which is what
 * makes the line the thing the eye keeps coming back to.
 */
export const companionBaselineFor = (avatarBox: number): number =>
  (COMPANION_BASE_AVATAR_IMAGE / 2) * companionScaleFor(avatarBox);

/**
 * That gap for a given pair of boxes.
 *
 * Scaled by the smaller of the two, because the gap is breathing room and the
 * smaller object is the one that decides how much of it there is: a modest
 * avatar beside an enormous pill wants the modest avatar's clearance, not the
 * chasm the pill's own scale would ask for.
 *
 * Derived here rather than on each side of the bridge, for the reason
 * {@link companionNearEdgeFor} is: main sizes the canvas to hold the pill's
 * reach past the avatar and the renderer positions the pill by the same
 * distance, so two copies of this drifting is a pill drawn somewhere main did
 * not leave room for.
 */
export const companionGapFor = (
  avatarBox: number,
  optionsBox: number,
): number =>
  (COMPANION_BASE_GAP * Math.min(avatarBox, optionsBox)) /
  COMPANION_BASE_AVATAR_BOX;

/**
 * The room the canvas keeps outside everything drawn into it, for a given pair
 * of boxes.
 *
 * The larger of the two scales, because the pad holds two overflows and either
 * one can be the bigger: the pill's shadow grows with the options size and the
 * avatar's glow with the avatar's. Sizing it from the smaller would clip
 * whichever of the two the user made large.
 */
export const companionPadFor = (
  avatarBox: number,
  optionsBox: number,
): number =>
  COMPANION_BASE_CANVAS_PAD *
  Math.max(companionScaleFor(avatarBox), companionScaleFor(optionsBox));

/**
 * How far the avatar's centre sits from the canvas edge the card does *not*
 * grow into, for a given pair of boxes.
 *
 * **The cross-process invariant.** Main places the window by it and the
 * renderer anchors the avatar by it, so the two agreeing is what makes the
 * avatar appear where the window was put. Derived once here rather than on each
 * side, because two copies of this formula drifting is the avatar drawn
 * somewhere other than where main believes it is.
 *
 * What has to clear that edge depends on which way the card grows, because the
 * pill stands on the creature's baseline ({@link companionBaselineFor}) rather
 * than on its box: growing up, the near side holds the avatar's own half box,
 * which runs below that line and is where the glow paints; growing down, the
 * pill stands on the baseline and reaches a whole options box back past it,
 * which pokes above a smaller creature. The larger of the two is taken so the
 * answer is the same either way, since a flip moves the canvas rather than
 * resizing it, and a near edge that changed with the direction would shift the
 * avatar by the difference.
 *
 * The far edge is {@link companionCardSideFor}, which the renderer never has to
 * state: `100%` names the canvas there, and main sizes it.
 */
export const companionNearEdgeFor = (
  avatarBox: number,
  optionsBox: number,
): number =>
  Math.max(avatarBox / 2, optionsBox - companionBaselineFor(avatarBox)) +
  companionPadFor(avatarBox, optionsBox);

/**
 * How far the avatar's centre sits from the canvas edge the card *does* grow
 * into, for a given pair of boxes.
 *
 * The far half of {@link companionNearEdgeFor}, taken over both growths for the
 * same reason. Growing up, the card stands on the creature's baseline and rises
 * its whole height from there; growing down, its composer row holds that line
 * and the rest of the card falls away below it. The avatar's own half box is
 * the floor under both, for a creature taller than the card beside it.
 *
 * Only main consumes this: the renderer names that edge with `100%` and lets
 * main size the canvas. It lives here to sit beside the constants it reads.
 */
export const companionCardSideFor = (
  avatarBox: number,
  optionsBox: number,
): number => {
  const scale = companionScaleFor(optionsBox);
  const baseline = companionBaselineFor(avatarBox);
  return (
    Math.max(
      COMPANION_BASE_CARD_HEIGHT * scale - baseline,
      (COMPANION_BASE_CARD_HEIGHT - COMPANION_BASE_AVATAR_BOX) * scale +
        baseline,
      avatarBox / 2,
    ) + companionPadFor(avatarBox, optionsBox)
  );
};

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
 * Where a finished watch session's summary has got to.
 *
 * A session ends the moment the user presses stop, and the account of it does
 * not: the runtime spends a full turn reading the timeline back before there is
 * anything to show. Those are the two states worth a surface, and neither is
 * `watching`, which is over by the time either is true.
 *
 * - `pending`: the turn is running. The surface says so, because a session that
 *   ends into silence reads as one that was thrown away.
 * - `ready`: there is a report to read, and the surface asks whether to open
 *   it.
 *
 * Absent is the resting answer, and covers both ends of the life: no session
 * has finished, or the last one that did was answered, dismissed, or produced
 * nothing to read.
 */
export type CompanionWatchRetro = "pending" | "ready";

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
  /**
   * Whether a turn is in flight right now.
   *
   * The surface has the tail of the conversation but no idea whether it is
   * still being written: the last turn on a finished exchange and the last turn
   * on one the assistant is still working through are the same rows. This is
   * the difference, and it is what the surface draws its working ring from.
   *
   * Published rather than inferred for the same reason the turns are. The turn
   * lives in the window that owns the conversation, and a surface guessing from
   * the shape of the tail would be wrong in both directions: a user message with
   * no reply yet is not proof of a live turn, and an assistant message already
   * on screen is no proof the turn behind it has ended.
   */
  working: boolean;
  /**
   * Whether a watch session is running, when the publisher knows.
   *
   * Optional here, and defaulted in `companionContextSchema`, because a
   * publisher that runs no watch session has nothing to report, and an omitted
   * value reads as no session of its running. Publishers that do run sessions
   * always send it.
   */
  watching?: boolean;
  /**
   * Where the last session's summary has got to, when the publisher knows.
   *
   * Optional for the same reason `watching` is, and answered by the same
   * window: the runtime reports the retrospective on the assistant's event
   * stream, which the app's window is subscribed to and the surface's is not.
   *
   * See {@link CompanionWatchRetro}. Omitted means there is nothing to say.
   */
  watchRetro?: CompanionWatchRetro;

  /**
   * How many times the running session has read the screen, counted from the
   * moment it started.
   *
   * A count rather than a timestamp: it crosses a process boundary, and two
   * sides comparing "when" would be two clocks, where comparing "how many"
   * only ever asks whether the number moved. Reset to zero by the session that
   * owns it, so a fresh session never inherits the last one's total and its
   * first read is unambiguously its first.
   *
   * Optional and defaulted for the same reason {@link CompanionContext.watching}
   * is: a publisher with no session to report says nothing, and zero reads is
   * the truthful reading of silence.
   */
  captureCount?: number;
}

/**
 * The feature flag key Teach is behind, as the app's window wrote it into
 * settings (`useElectronFeatureFlagBridge`).
 *
 * The constant's name and the key it holds spell the feature differently: the
 * symbols around it say Watch, everything a person reads says Teach. A flag key
 * is one of the things a person reads, in the LaunchDarkly dashboard.
 *
 * Here rather than in either client, because two clients read the same
 * evaluation for two halves of one gate: Electron main reads it to decide
 * whether the companion surface draws the Teach control at all, and the web
 * app's `toggleWatch` command reads it to decide whether a press may start a
 * session. A second copy of the string is a gate that can disagree with
 * itself, and both ways it can disagree are bad: a visible control that
 * nothing will start, or a command open with no control that says so.
 *
 * The evaluated value travels to the surface on
 * {@link CompanionSurfaceState.watchEnabled}; this is only the key it is
 * evaluated under.
 */
export const WATCH_FLAG = "teach";

/**
 * The beats of the surface's one-time introduction, in order.
 *
 * The companion is the only thing this app puts on a user's desktop rather than
 * in its own window, and it arrives already there rather than being opened. So
 * it says what it is once, on itself, where the thing being described actually
 * is: the alternative was describing it in the app window, which is the one
 * place the user is not looking when the surface matters.
 *
 * A list rather than a count, because each beat names the control it sits over
 * and the renderer spotlights that control by name. Two of them have no
 * control to spotlight: `meet` is the avatar itself, and `menu` is about a
 * press rather than a control drawn on the pill.
 *
 * `menu` is last and is the answer to "how do I make this go away" and "how do
 * I make it a different size". A surface that sits above every other window has
 * to say where its own off switch is, and the right-click menu it points at is
 * the only part of this the user cannot find by looking at the pill.
 */
export const COMPANION_INTRO_BEATS = ["meet", "talk", "type", "menu"] as const;

export type CompanionIntroBeat = (typeof COMPANION_INTRO_BEATS)[number];

/**
 * What a press on the introduction asks for.
 *
 * Two intents rather than a beat to jump to, because the renderer does not hold
 * the running position: main does, so the renderer says which way to go and
 * main resolves it against the beat it is actually on. A stale press from a
 * renderer a beat behind then lands where the user could see it would.
 */
export const COMPANION_INTRO_ACTIONS = ["next", "dismiss"] as const;

export type CompanionIntroAction = (typeof COMPANION_INTRO_ACTIONS)[number];

/** What main tells the companion renderer. */
export interface CompanionSurfaceState {
  growth: CompanionGrowth;
  /**
   * Which way the typing card unfurls, and with it where the avatar sits inside
   * the canvas. See {@link CompanionCardGrowth}: main owns the window position,
   * so main is the only side that can decide this.
   */
  cardGrowth: CompanionCardGrowth;
  /**
   * The avatar's box in points, which is the creature's whole scale.
   *
   * Numbers rather than the named sizes, because a name is a lookup both sides
   * would then have to hold the same copy of. See {@link companionBoxFor}, and
   * {@link COMPANION_SIZE_AXES} for why there are two of them.
   */
  avatarBox: number;
  /**
   * The pill's box in points, which is the scale of everything that is not the
   * creature: the pill, the typing card, the call's body and the introduction.
   *
   * The renderer draws the surface at this over the size its layout is authored
   * at and scales the creature inside that by the ratio between the two boxes,
   * so every length beside the avatar stays stated once, at the base size.
   *
   * Optional, and absence means a shell that predates the second axis, which
   * the renderer reads as {@link CompanionSurfaceState.avatarBox}.
   */
  optionsBox?: number;
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
   * Whether a turn is in flight, as the window holding it last reported.
   *
   * What the surface turns into a signal a glance can read, so the assistant
   * being busy does not have to be inferred from the words on the card. See
   * {@link CompanionContext.working}.
   */
  working: boolean;
  /**
   * Whether a watch session is running, from the toggle until it ends.
   *
   * Pushed by the window that owns the session for the same reason
   * {@link CompanionSurfaceState.working} is: the session lives in the app's
   * window and the surface is only where it was asked for. Held here rather
   * than kept in the surface's own renderer for the same reason the turns are,
   * and with more riding on it: the surface can reload mid-session, and a
   * screen being read with nothing on screen saying so is a capture the user
   * has no way to stop.
   *
   * Optional, and absence means not watching. Read it as `watching === true`
   * rather than for truthiness: every state that is not a positive answer is
   * the answer "no session", including a state pushed by a main process that
   * tracks no watch sessions. The same bargain `companion-window.ts` makes for
   * the surface flag, and for the same reason: not knowing has to read as not
   * running, because the alternative is drawing a capture indicator over a
   * machine that is not being captured.
   */
  watching?: boolean;
  /**
   * Where the last session's summary has got to, as the window that ran it
   * last reported. See {@link CompanionWatchRetro}.
   *
   * Held here rather than in the surface's own renderer for the reason the
   * turns are: the retrospective runs long enough that the surface can reload
   * inside it, and a prompt that came back empty would be a question the user
   * was asked and then never got to answer.
   *
   * Optional, and absence means there is nothing to draw.
   */
  watchRetro?: CompanionWatchRetro;

  /**
   * How many screen reads the running session has taken, from the window that
   * owns it. See {@link CompanionContext.captureCount}.
   *
   * {@link CompanionSurfaceState.watching} says a session is open, which is a
   * state that holds for minutes; this is what lets the surface mark the
   * discrete moments inside it. Each increment is one read that reached the
   * runtime's timeline, so a surface may treat a step in this number as proof
   * the screen was read and the flat stretches between as proof it was not.
   *
   * Optional, and absence reads as no reads yet, the same bargain
   * {@link CompanionSurfaceState.watching} makes with absence.
   */
  captureCount?: number;

  /**
   * Whether Watch is offered at all, as the flag was last evaluated for the
   * signed-in user.
   *
   * Carried on the state rather than read where it is drawn, because the
   * surface is a floating route: it has no session, no auth, and no flag store
   * that ever hydrates, so a value it read for itself would be the registry
   * default forever. Main reads the evaluation the app's window wrote into
   * settings and pushes it here with everything else, which is the same path
   * `companion-window.ts` already takes for the surface's own flag.
   *
   * Optional, and absence means not offered. Read it as `watchEnabled === true`
   * for the reason {@link CompanionSurfaceState.watching} is read that way: a
   * shell that predates the field, a window whose flags have not synced yet,
   * and an environment where the flag was never provisioned are all states of
   * not knowing, and a control that reads a user's screen is not something to
   * offer while the answer is unknown.
   */
  watchEnabled?: boolean;
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
  /**
   * Which beat of the introduction the surface is on, or `null` when it is not
   * running, which is every launch after the first.
   *
   * Held by main rather than the renderer, for the reason the session is: this
   * window reloads, and an introduction anchored in it would start again from
   * the top each time it did. Main also owns the "already seen" record, so the
   * renderer never has to decide whether a run is due.
   */
  intro: CompanionIntroBeat | null;
}

// ---------------------------------------------------------------------------
// Windows title bar
// ---------------------------------------------------------------------------

/** Which of the app's two color schemes a theme paints. */
export type ColorScheme = "light" | "dark";

/**
 * How the Windows title-bar overlay (the native minimize / maximize / close
 * buttons drawn over the webview) is painted.
 *
 * The overlay is chrome the OS draws, so it has no access to the renderer's
 * theme tokens and defaults to the system caption colors. The renderer
 * publishes the active theme's surface and content colors so the buttons match
 * the title bar they sit in, plus the scheme those colors come from, which is
 * what Chromium derives the buttons' hover and press wash from.
 *
 * The colors are CSS color strings, which Electron parses with Chromium's color
 * parser (hex, `rgb()`, `hsl()`, and named colors).
 *
 * @see https://www.electronjs.org/docs/latest/tutorial/window-customization#set-custom-window-controls-colors
 */
export interface TitleBarOverlayTheme {
  /** The overlay's background, matching the title bar's own surface. */
  color: string;
  /** The button glyphs, matching the title bar's text. */
  symbolColor: string;
  /** The scheme the two colors are drawn from. */
  colorScheme: ColorScheme;
}
