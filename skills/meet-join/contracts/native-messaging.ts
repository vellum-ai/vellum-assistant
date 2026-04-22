/**
 * Wire-protocol contracts for the Chrome Native Messaging stdio pipe that
 * connects the meet-bot's in-container extension (running inside Chromium)
 * to the bot process.
 *
 * Chrome's native-messaging transport carries length-prefixed JSON frames.
 * This module defines the JSON payload shapes on top of that transport in
 * two directions:
 *
 * - **Extension → Bot**: handshake, lifecycle transitions, meeting telemetry
 *   (participant/speaker/chat), diagnostics, and command results. See
 *   {@link ExtensionToBotMessage} and {@link ExtensionToBotMessageSchema}.
 * - **Bot → Extension**: join / leave / send_chat commands. See
 *   {@link BotToExtensionMessage} and {@link BotToExtensionMessageSchema}.
 *
 * These schemas are intentionally independent of the broader
 * daemon ↔ bot {@link MeetBotEvent}/{@link MeetBotCommand} protocol, though
 * some shapes (participant/speaker/chat) are reused verbatim from `events.ts`
 * so the extension and the bot agree on a single canonical structure.
 */

import { z } from "zod";

import {
  InboundChatEventSchema,
  ParticipantChangeEventSchema,
  SpeakerChangeEventSchema,
} from "./events.js";

// ---------------------------------------------------------------------------
// Extension → Bot
// ---------------------------------------------------------------------------

/**
 * Initial handshake emitted by the extension once its background service
 * worker has connected to the native-messaging host.
 */
export const ExtensionReadyMessageSchema = z.object({
  type: z.literal("ready"),
  /** SemVer of the extension build, for compatibility logging. */
  extensionVersion: z.string().min(1),
});
export type ExtensionReadyMessage = z.infer<typeof ExtensionReadyMessageSchema>;

/**
 * Lifecycle state values reported by the extension to the bot. Mirrors
 * {@link ./events.js}'s `LifecycleStateSchema` — keep these enums in sync so
 * the extension-side and daemon-side lifecycle telemetry share a single
 * vocabulary.
 */
export const ExtensionLifecycleStateSchema = z.enum([
  "joining",
  "joined",
  "leaving",
  "left",
  "error",
]);
export type ExtensionLifecycleState = z.infer<
  typeof ExtensionLifecycleStateSchema
>;

/**
 * Lifecycle transition mirrored from the extension's join flow. This is the
 * extension-side counterpart to the daemon-facing `LifecycleEvent` in
 * {@link ./events.js} — it carries the same state transitions but flows
 * over the native-messaging pipe rather than the daemon channel.
 */
export const ExtensionLifecycleMessageSchema = z.object({
  type: z.literal("lifecycle"),
  state: ExtensionLifecycleStateSchema,
  /** Optional human-readable detail (required-ish for `error`). */
  detail: z.string().optional(),
  /** Opaque identifier for the meeting the extension is in. */
  meetingId: z.string().min(1),
  /** ISO-8601 timestamp of when the transition occurred in the extension. */
  timestamp: z.string().min(1),
});
export type ExtensionLifecycleMessage = z.infer<
  typeof ExtensionLifecycleMessageSchema
>;

/**
 * Participant join/leave delta reported by the extension. Payload shape
 * mirrors {@link ParticipantChangeEventSchema} so the bot can fan out to
 * the daemon without reshaping.
 */
export const ExtensionParticipantChangeMessageSchema =
  ParticipantChangeEventSchema;
export type ExtensionParticipantChangeMessage = z.infer<
  typeof ExtensionParticipantChangeMessageSchema
>;

/**
 * Active-speaker change reported by the extension. Payload shape mirrors
 * {@link SpeakerChangeEventSchema}.
 */
export const ExtensionSpeakerChangeMessageSchema = SpeakerChangeEventSchema;
export type ExtensionSpeakerChangeMessage = z.infer<
  typeof ExtensionSpeakerChangeMessageSchema
>;

/**
 * Inbound chat message observed by the extension. Payload shape mirrors
 * {@link InboundChatEventSchema}.
 */
export const ExtensionInboundChatMessageSchema = InboundChatEventSchema;
export type ExtensionInboundChatMessage = z.infer<
  typeof ExtensionInboundChatMessageSchema
>;

/** Severity for an extension-side diagnostic message. */
export const ExtensionDiagnosticLevelSchema = z.enum(["info", "error"]);
export type ExtensionDiagnosticLevel = z.infer<
  typeof ExtensionDiagnosticLevelSchema
>;

/**
 * Diagnostic log line emitted by the extension that the bot should surface
 * (e.g. re-emit as a structured log entry).
 */
export const ExtensionDiagnosticMessageSchema = z.object({
  type: z.literal("diagnostic"),
  level: ExtensionDiagnosticLevelSchema,
  message: z.string().min(1),
});
export type ExtensionDiagnosticMessage = z.infer<
  typeof ExtensionDiagnosticMessageSchema
>;

/**
 * Ask the bot to dispatch a REAL X-server mouse click at the given screen
 * coordinates (via xdotool inside the bot container). Google Meet gates
 * several critical buttons (the prejoin admission button in particular)
 * on `event.isTrusted === true`, which JS `.click()` from a content script
 * cannot produce — only X-server-originated events carry that flag. The
 * extension emits this message when it needs a trusted click; the bot
 * runs xdotool and the extension confirms success by observing the DOM
 * transition (no separate response message — the DOM is the source of
 * truth and avoids an otherwise-unused correlation path).
 *
 * Coordinates are **screen-space** (absolute pixels on Xvfb's virtual
 * display), NOT viewport-relative — the extension is responsible for
 * translating `clientX/clientY` using `window.screenX/screenY` plus the
 * Chromium chrome offset (`outerHeight - innerHeight`). The bot performs
 * NO coordinate translation; it passes the values straight to xdotool.
 */
export const ExtensionTrustedClickMessageSchema = z.object({
  type: z.literal("trusted_click"),
  /** Screen-space X coordinate on the Xvfb virtual display. */
  x: z.number().int().min(0).max(10_000),
  /** Screen-space Y coordinate on the Xvfb virtual display. */
  y: z.number().int().min(0).max(10_000),
});
export type ExtensionTrustedClickMessage = z.infer<
  typeof ExtensionTrustedClickMessageSchema
>;

/**
 * Ask the bot to type text into the currently-focused input field via
 * `xdotool type` inside the bot container. This is the keyboard-input
 * analogue of {@link ExtensionTrustedClickMessageSchema}: Google Meet may
 * gate composer input events on `event.isTrusted === true` in addition to
 * the prejoin admission button, and synthetic `InputEvent`s dispatched from
 * a content script cannot produce trusted events — only X-server-originated
 * keystrokes carry that flag.
 *
 * The bot performs NO coordinate math and NO element targeting: the
 * extension is responsible for focusing the correct element (e.g. by
 * calling `.focus()` on the composer textarea) **before** emitting this
 * message. The bot simply invokes `xdotool type` against whatever is
 * currently focused on the Xvfb display.
 */
/**
 * Google Meet's single-message chat cap. Shared across contracts so every
 * site that sizes timeouts or validates length uses the same number, and
 * so the daemon can clamp untrusted inputs before deriving a per-request
 * timeout (see {@link trustedTypeHttpTimeoutMs}).
 */
export const MEET_CHAT_MAX_LENGTH = 2000;

export const ExtensionTrustedTypeMessageSchema = z.object({
  type: z.literal("trusted_type"),
  /** Text to type via `xdotool type`. Length-capped to Meet's 2000-char chat limit. */
  text: z.string().min(1).max(MEET_CHAT_MAX_LENGTH),
  /** Optional per-keystroke delay (ms), passed as `xdotool --delay`. */
  delayMs: z.number().int().min(0).max(500).optional(),
});
export type ExtensionTrustedTypeMessage = z.infer<
  typeof ExtensionTrustedTypeMessageSchema
>;

// ---------------------------------------------------------------------------
// Shared trusted-type timing helpers
// ---------------------------------------------------------------------------
//
// xdotool's per-keystroke delay (default 25ms) makes typing duration scale
// linearly with text length: a 2000-char chat (Meet's max) takes 50s of
// real-time keystroke dispatch on the bot's Xvfb display. The four sites
// that bound this round-trip — extension wait between trusted_type emit
// and send-button click, bot xdotoolType kill timer, bot send_chat reply
// timer, daemon HTTP timeout — must all derive from the SAME formula or
// the chain pre-empts itself: short timeouts kill xdotool mid-type and
// post truncated text; mismatched timeouts surface false failures while
// the extension still completes successfully.
//
// These helpers are the single source of truth shared across all four
// sites. The reason each successive timeout is larger than the one inside
// it is simply that the outer waiter has to cover the inner work plus
// transit (native-messaging hop, HTTP round-trip).

/**
 * Default xdotool `--delay` value in milliseconds. Mirrors
 * `DEFAULT_DELAY_MS` in `bot/src/browser/xdotool-type.ts` — kept aligned
 * so the timing helpers below correctly predict typing duration when the
 * extension does not pass an explicit `delayMs`.
 */
export const TRUSTED_TYPE_DEFAULT_DELAY_MS = 25;

/**
 * Fixed overhead for the xdotool spawn + the native-messaging round-trip
 * from extension → bot → X server (emit → first keystroke dispatched).
 * Sized from observed production latency with a small safety margin.
 */
export const TRUSTED_TYPE_OVERHEAD_MS = 250;

/**
 * Extra slack added on top of the predicted typing duration when sizing
 * the xdotool kill timer in the bot. Covers OS-scheduling jitter on the
 * Xvfb display and the time xdotool itself takes to release after the
 * final keystroke. Independent of the extension wait so a larger value
 * here cannot push xdotool past the moment the extension dispatches the
 * send-button click.
 */
const TRUSTED_TYPE_KILL_SLACK_MS = 5_000;

/**
 * Slack added on top of the typing duration when sizing the bot's
 * `send_chat` reply timer. Must cover: extension's typing wait → send-
 * button click → DOM transition → `send_chat_result` native-messaging
 * frame back to the bot. Generous enough that minor extension scheduling
 * slips don't surface as user-visible failures.
 */
const TRUSTED_TYPE_REPLY_SLACK_MS = 10_000;

/**
 * Slack added on top of the bot's `send_chat` reply timer when sizing
 * the daemon's `/send_chat` HTTP timeout. Covers the HTTP round-trip
 * between daemon and bot container so the daemon does not pre-empt a
 * reply that is genuinely on its way.
 */
const TRUSTED_TYPE_HTTP_SLACK_MS = 5_000;

/**
 * Predict how long xdotool will spend typing `textLength` characters at
 * the given per-keystroke `delayMs` (default
 * {@link TRUSTED_TYPE_DEFAULT_DELAY_MS}). This is the lower bound the
 * extension must wait between emitting `trusted_type` and clicking the
 * send button — clicking earlier would post a partial message.
 */
export function trustedTypeDurationMs(
  textLength: number,
  delayMs: number = TRUSTED_TYPE_DEFAULT_DELAY_MS,
): number {
  return textLength * delayMs + TRUSTED_TYPE_OVERHEAD_MS;
}

/**
 * Recommended kill timeout for the bot-side xdotool process. Returns the
 * predicted typing duration plus {@link TRUSTED_TYPE_KILL_SLACK_MS}. The
 * bot's `trusted_type` handler passes this to `xdotoolType` so long
 * messages are not killed mid-type (the legacy fixed 15s ceiling truncated
 * any chat above ~590 characters).
 */
export function trustedTypeKillTimeoutMs(
  textLength: number,
  delayMs?: number,
): number {
  return trustedTypeDurationMs(textLength, delayMs) + TRUSTED_TYPE_KILL_SLACK_MS;
}

/**
 * Recommended `send_chat` reply timeout for the bot. Must exceed the
 * extension's typing wait plus the post-type click round-trip. The bot's
 * `sendChatViaExtension` uses this value when starting the reply timer so
 * valid sub-2000-char messages do not surface false failures.
 */
export function trustedTypeReplyTimeoutMs(
  textLength: number,
  delayMs?: number,
): number {
  return (
    trustedTypeDurationMs(textLength, delayMs) + TRUSTED_TYPE_REPLY_SLACK_MS
  );
}

/**
 * Recommended `/send_chat` HTTP timeout for the daemon. Sized to outlive
 * the bot's reply timer by a small margin so the HTTP layer never
 * pre-empts a reply that is genuinely in flight. The daemon's
 * `defaultBotSendChatFetch` uses this value per request.
 */
export function trustedTypeHttpTimeoutMs(
  textLength: number,
  delayMs?: number,
): number {
  return (
    trustedTypeReplyTimeoutMs(textLength, delayMs) + TRUSTED_TYPE_HTTP_SLACK_MS
  );
}

/**
 * Result of a prior `send_chat` command, correlated by `requestId`.
 *
 * `ok: false` payloads should set `error` to a human-readable string so the
 * bot can surface a meaningful failure reason.
 */
export const ExtensionSendChatResultMessageSchema = z.object({
  type: z.literal("send_chat_result"),
  /** Correlation id from the originating `send_chat` command. */
  requestId: z.string().min(1),
  /** Whether the extension successfully posted the chat message. */
  ok: z.boolean(),
  /** Human-readable failure reason when `ok === false`. */
  error: z.string().optional(),
});
export type ExtensionSendChatResultMessage = z.infer<
  typeof ExtensionSendChatResultMessageSchema
>;

/**
 * Minimum byte size a resolved GLB must have before the extension
 * treats it as a real asset. The repo ships a 0-byte placeholder at
 * `meet-controller-ext/avatar/default-avatar.glb` (see the README in
 * that directory) that operators must replace before production use.
 * A real Ready Player Me GLB is multi-MB; 1 KiB is well below any
 * valid GLB header so the threshold is safe to use as a placeholder
 * sentinel without false positives on legitimately-small models.
 */
export const AVATAR_GLB_MIN_SIZE_BYTES = 1024;

/**
 * Ack emitted by the extension once its avatar tab has mounted and the
 * TalkingHead.js renderer is ready to receive visemes. This is the
 * extension-side counterpart to the bot's `avatar.start` command and lets
 * the bot's TalkingHead renderer complete its own `start()` promise with a
 * bounded wait (fallback to noop on timeout).
 *
 * `placeholderDetected` + `glbSize` are set by the avatar tab when it
 * fetches the resolved GLB URL and observes a size below
 * {@link AVATAR_GLB_MIN_SIZE_BYTES} (or the fetch fails entirely, in
 * which case `glbSize` is `0`). The bot-side renderer inspects these
 * fields on the ack and throws `AvatarRendererUnavailableError` with a
 * pointer to the avatar README so operators who enabled the avatar
 * without replacing the bundled placeholder get a clear error rather
 * than a blank video stream. Both fields are optional for
 * backwards-compatibility with older extension builds that predate the
 * check — a missing `placeholderDetected` is treated as "no signal".
 */
export const ExtensionAvatarStartedMessageSchema = z.object({
  type: z.literal("avatar.started"),
  /**
   * True when the avatar tab fetched its configured GLB at load time
   * and found the file was smaller than {@link AVATAR_GLB_MIN_SIZE_BYTES}
   * (or the fetch failed entirely).
   */
  placeholderDetected: z.boolean().optional(),
  /**
   * Byte size of the resolved GLB as observed by the avatar tab.
   * `0` when the fetch failed entirely. Only present when
   * `placeholderDetected` is also set.
   */
  glbSize: z.number().int().nonnegative().optional(),
});
export type ExtensionAvatarStartedMessage = z.infer<
  typeof ExtensionAvatarStartedMessageSchema
>;

/**
 * Valid formats for an `avatar.frame` payload.
 *
 * - `"jpeg"` — JPEG bytes produced by `HTMLCanvasElement.toBlob("image/jpeg")`.
 *   The bot transcodes these to Y4M via a short-lived ffmpeg child before
 *   writing to `/dev/video10`.
 * - `"y4m"` — already-framed Y4M bytes (future streaming-capture path).
 *   The bot emits these directly via `onFrame`.
 */
export const AvatarFrameFormatSchema = z.enum(["jpeg", "y4m"]);
export type AvatarFrameFormat = z.infer<typeof AvatarFrameFormatSchema>;

/**
 * A single rendered frame produced by the TalkingHead.js avatar tab and
 * forwarded by the extension to the bot over native messaging. The bot
 * re-emits the frame bytes through its avatar renderer's `onFrame`
 * subscriber chain, which feeds the v4l2loopback camera device that
 * Chrome in the Meet tab reads from.
 *
 * Bytes ride the wire as a base64 string because Chrome's native-messaging
 * transport is JSON-only — we cannot ship a raw `ArrayBuffer`. The
 * extension base64-encodes the canvas-capture payload before posting;
 * the bot decodes inside `talking-head/renderer.ts`.
 */
export const ExtensionAvatarFrameMessageSchema = z.object({
  type: z.literal("avatar.frame"),
  /** Base64-encoded frame bytes. */
  bytes: z.string().min(1),
  /** Frame width in pixels. */
  width: z.number().int().positive(),
  /** Frame height in pixels. */
  height: z.number().int().positive(),
  /** Pixel/container format of `bytes`. */
  format: AvatarFrameFormatSchema,
  /**
   * Monotonic timestamp (ms) of when the frame was captured inside the
   * avatar tab. Downstream audio-alignment (PR 9) keys off this value;
   * for v1 the bot emits frames in arrival order and the daemon does no
   * timestamp gating.
   */
  ts: z.number(),
});
export type ExtensionAvatarFrameMessage = z.infer<
  typeof ExtensionAvatarFrameMessageSchema
>;

/**
 * Result of a prior `camera.enable` / `camera.disable` command, correlated
 * by `requestId`. Semantics mirror {@link ExtensionSendChatResultMessageSchema}:
 *
 * - `ok: true` indicates the extension confirmed the Meet camera toggle
 *   reached the requested state (either because a click was dispatched and
 *   the aria-state transition was observed, or because the toggle was
 *   already in the requested state — see `changed`).
 * - `ok: false` indicates the extension could not bring the toggle to the
 *   requested state (toggle element missing, aria-state polling timed out).
 *   `error` carries a human-readable reason the bot surfaces in logs.
 * - `changed` distinguishes a no-op short-circuit (`false` — toggle was
 *   already in the requested state) from a successful click that produced
 *   a state transition (`true`). The bot uses this for observability — a
 *   spammy `/avatar/enable` retry loop that keeps reporting `changed=false`
 *   is informative signal that the renderer is flapping without the camera
 *   drifting.
 */
export const ExtensionCameraResultMessageSchema = z.object({
  type: z.literal("camera_result"),
  /** Correlation id from the originating `camera.enable` / `camera.disable` command. */
  requestId: z.string().min(1),
  /** Whether the camera toggle reached the requested state. */
  ok: z.boolean(),
  /**
   * True if a click was dispatched and the aria-state transition was
   * observed; false if the toggle was already in the requested state (no
   * click happened). Only meaningful when `ok === true`.
   */
  changed: z.boolean().optional(),
  /** Human-readable failure reason when `ok === false`. */
  error: z.string().optional(),
});
export type ExtensionCameraResultMessage = z.infer<
  typeof ExtensionCameraResultMessageSchema
>;

/**
 * Every payload the extension may send to the bot over the native-messaging
 * pipe. Consumers should parse incoming frames with this schema to both
 * validate and narrow on `type`.
 */
export const ExtensionToBotMessageSchema = z.discriminatedUnion("type", [
  ExtensionReadyMessageSchema,
  ExtensionLifecycleMessageSchema,
  ExtensionParticipantChangeMessageSchema,
  ExtensionSpeakerChangeMessageSchema,
  ExtensionInboundChatMessageSchema,
  ExtensionDiagnosticMessageSchema,
  ExtensionTrustedClickMessageSchema,
  ExtensionTrustedTypeMessageSchema,
  ExtensionSendChatResultMessageSchema,
  ExtensionAvatarStartedMessageSchema,
  ExtensionAvatarFrameMessageSchema,
  ExtensionCameraResultMessageSchema,
]);
export type ExtensionToBotMessage = z.infer<typeof ExtensionToBotMessageSchema>;

/** All extension→bot `type` discriminator values as a const tuple. */
export const EXTENSION_TO_BOT_MESSAGE_TYPES = [
  "ready",
  "lifecycle",
  "participant.change",
  "speaker.change",
  "chat.inbound",
  "diagnostic",
  "trusted_click",
  "trusted_type",
  "send_chat_result",
  "avatar.started",
  "avatar.frame",
  "camera_result",
] as const;

export type ExtensionToBotMessageType =
  (typeof EXTENSION_TO_BOT_MESSAGE_TYPES)[number];

// ---------------------------------------------------------------------------
// Bot → Extension
// ---------------------------------------------------------------------------

/**
 * Ask the extension to drive the Meet join flow for the given meeting.
 *
 * `consentMessage` is the verbal/written consent that the extension will
 * post in chat on joining, so participants understand the bot is present
 * on the user's behalf.
 */
export const BotJoinCommandSchema = z.object({
  type: z.literal("join"),
  /** Full Meet join URL. */
  meetingUrl: z.string().min(1),
  /** Display name the bot should use when joining. */
  displayName: z.string().min(1),
  /** Consent string the extension will post in chat on joining. */
  consentMessage: z.string().min(1),
});
export type BotJoinCommand = z.infer<typeof BotJoinCommandSchema>;

/**
 * Ask the extension to cleanly leave the current meeting. Mirrors the
 * daemon-facing `LeaveCommandSchema` in {@link ./commands.js} — `reason` is
 * optional there, so it is optional here too (a native-messaging bridge
 * that forwards a reasonless leave must not be rejected).
 */
export const BotLeaveCommandSchema = z.object({
  type: z.literal("leave"),
  /** Optional human-readable reason, surfaced in logs/telemetry. */
  reason: z.string().min(1).optional(),
});
export type BotLeaveCommand = z.infer<typeof BotLeaveCommandSchema>;

/**
 * Ask the extension to type a chat message. The extension replies with a
 * `send_chat_result` carrying the same `requestId`.
 */
export const BotSendChatCommandSchema = z.object({
  type: z.literal("send_chat"),
  /** Chat message text to post. */
  text: z.string().min(1),
  /** Correlation id the extension must echo back in `send_chat_result`. */
  requestId: z.string().min(1),
});
export type BotSendChatCommand = z.infer<typeof BotSendChatCommandSchema>;

// ---------------------------------------------------------------------------
// camera.enable / camera.disable — toggle the Meet camera via the extension.
//
// The bot drives the Meet camera via the extension (not via any CDP path)
// because Meet's bottom-toolbar buttons are inside the same DOM the extension
// already manages. The extension reads the camera-toggle button's aria-label
// to determine current state, short-circuits when the toggle is already in
// the requested state, clicks the toggle otherwise, then polls the aria-state
// for up to 5s to confirm the transition landed.
//
// Reply shape: {@link ExtensionCameraResultMessageSchema}, correlated by
// `requestId`.
// ---------------------------------------------------------------------------

/**
 * Ask the extension to turn the Meet camera ON. If the camera is already on,
 * the extension short-circuits without clicking. The extension replies with
 * a `camera_result` carrying the same `requestId`.
 */
export const BotCameraEnableCommandSchema = z.object({
  type: z.literal("camera.enable"),
  /** Correlation id the extension must echo back in `camera_result`. */
  requestId: z.string().min(1),
});
export type BotCameraEnableCommand = z.infer<
  typeof BotCameraEnableCommandSchema
>;

/**
 * Ask the extension to turn the Meet camera OFF. If the camera is already
 * off, the extension short-circuits without clicking. The extension replies
 * with a `camera_result` carrying the same `requestId`.
 */
export const BotCameraDisableCommandSchema = z.object({
  type: z.literal("camera.disable"),
  /** Correlation id the extension must echo back in `camera_result`. */
  requestId: z.string().min(1),
});
export type BotCameraDisableCommand = z.infer<
  typeof BotCameraDisableCommandSchema
>;

/**
 * Ask the extension to open the avatar tab (TalkingHead.js-rendered 3D
 * face) and begin capturing canvas frames. The extension replies with an
 * `avatar.started` frame once the avatar tab has mounted and is ready to
 * accept visemes. If the ack doesn't arrive within a few seconds, the
 * bot-side renderer throws `AvatarRendererUnavailableError` so the
 * session-manager can fall back to the noop renderer.
 *
 * `targetFps` is advisory — the extension uses it to size its
 * `requestAnimationFrame` capture cadence. The bot also applies an FPS
 * cap at the device-writer layer, so the extension need not match it
 * exactly.
 */
export const BotAvatarStartCommandSchema = z.object({
  type: z.literal("avatar.start"),
  /** Target capture framerate hint. Advisory; the bot rate-limits again. */
  targetFps: z.number().int().min(1).max(60).optional(),
  /**
   * Optional URL override for the avatar page / GLB. When absent the
   * extension falls back to the bundled `chrome.runtime.getURL("avatar/avatar.html")`
   * + bundled `default-avatar.glb`. When present, the bot is expected
   * to have staged the GLB as a `web_accessible_resources` entry so
   * `chrome.runtime.getURL` can resolve it. See `features/avatar.ts`.
   */
  modelUrl: z.string().optional(),
});
export type BotAvatarStartCommand = z.infer<typeof BotAvatarStartCommandSchema>;

/**
 * Tear down the avatar tab and stop capturing frames. Idempotent: a
 * second `avatar.stop` while the tab is already closed is a no-op on
 * the extension side.
 */
export const BotAvatarStopCommandSchema = z.object({
  type: z.literal("avatar.stop"),
});
export type BotAvatarStopCommand = z.infer<typeof BotAvatarStopCommandSchema>;

/**
 * Forward a viseme/amplitude event into the running avatar tab. The
 * extension's feature background module relays the event into the
 * avatar tab via `chrome.tabs.sendMessage`. The avatar content script
 * drives TalkingHead.js's blend-shape weights from the viseme payload.
 *
 * Mirrors `VisemeEvent` from the bot's avatar types. Kept schema-local
 * (rather than re-exporting from avatar/types.ts) so the contracts
 * package stays independent of the bot implementation.
 */
export const BotAvatarPushVisemeCommandSchema = z.object({
  type: z.literal("avatar.push_viseme"),
  /**
   * Phoneme or viseme identifier. Providers that emit viseme/alignment
   * metadata use their native label; the amplitude-envelope fallback
   * uses the sentinel `"amp"`.
   */
  phoneme: z.string().min(1),
  /** Mouth-openness weight in `[0, 1]`. */
  weight: z.number().min(0).max(1),
  /** Monotonic timestamp (ms) used to align the viseme with the audio. */
  timestamp: z.number(),
});
export type BotAvatarPushVisemeCommand = z.infer<
  typeof BotAvatarPushVisemeCommandSchema
>;

/**
 * Every command the bot may send to the extension over the native-messaging
 * pipe. Consumers should parse incoming frames with this schema to both
 * validate and narrow on `type`.
 */
export const BotToExtensionMessageSchema = z.discriminatedUnion("type", [
  BotJoinCommandSchema,
  BotLeaveCommandSchema,
  BotSendChatCommandSchema,
  BotAvatarStartCommandSchema,
  BotAvatarStopCommandSchema,
  BotAvatarPushVisemeCommandSchema,
  BotCameraEnableCommandSchema,
  BotCameraDisableCommandSchema,
]);
export type BotToExtensionMessage = z.infer<typeof BotToExtensionMessageSchema>;

/** All bot→extension `type` discriminator values as a const tuple. */
export const BOT_TO_EXTENSION_MESSAGE_TYPES = [
  "join",
  "leave",
  "send_chat",
  "avatar.start",
  "avatar.stop",
  "avatar.push_viseme",
  "camera.enable",
  "camera.disable",
] as const;

export type BotToExtensionMessageType =
  (typeof BOT_TO_EXTENSION_MESSAGE_TYPES)[number];
