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

/** Lifecycle state values reported by the extension to the bot. */
export const ExtensionLifecycleStateSchema = z.enum([
  "joining",
  "joined",
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
  ExtensionSendChatResultMessageSchema,
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
  "send_chat_result",
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

/** Ask the extension to cleanly leave the current meeting. */
export const BotLeaveCommandSchema = z.object({
  type: z.literal("leave"),
  /** Human-readable reason, surfaced in logs/telemetry. */
  reason: z.string().min(1),
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

/**
 * Every command the bot may send to the extension over the native-messaging
 * pipe. Consumers should parse incoming frames with this schema to both
 * validate and narrow on `type`.
 */
export const BotToExtensionMessageSchema = z.discriminatedUnion("type", [
  BotJoinCommandSchema,
  BotLeaveCommandSchema,
  BotSendChatCommandSchema,
]);
export type BotToExtensionMessage = z.infer<typeof BotToExtensionMessageSchema>;

/** All bot→extension `type` discriminator values as a const tuple. */
export const BOT_TO_EXTENSION_MESSAGE_TYPES = [
  "join",
  "leave",
  "send_chat",
] as const;

export type BotToExtensionMessageType =
  (typeof BOT_TO_EXTENSION_MESSAGE_TYPES)[number];
