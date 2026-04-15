/**
 * Commands sent from the assistant daemon to the meet-bot.
 *
 * All commands share a `type` discriminator. Consumers should parse
 * incoming payloads with {@link MeetBotCommandSchema} before branching
 * on `type`.
 *
 * Note on audio: `PlayAudioCommand` carries only metadata. The actual PCM
 * stream is delivered out of band (see the Phase 3 audio channel), so
 * large binary bodies never flow through this JSON schema.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// send_chat
// ---------------------------------------------------------------------------

/** Post a chat message from the bot into the meeting chat. */
export const SendChatCommandSchema = z.object({
  type: z.literal("send_chat"),
  /** The chat message text to post. */
  text: z.string().min(1),
});
export type SendChatCommand = z.infer<typeof SendChatCommandSchema>;

// ---------------------------------------------------------------------------
// play_audio
// ---------------------------------------------------------------------------

/**
 * Instruct the bot to play an audio stream referenced by `streamId`.
 *
 * The PCM stream itself is delivered over a separate out-of-band channel
 * (chunked transfer in Phase 3); this command only carries the metadata
 * needed to correlate the stream with the bot's audio pipeline.
 */
export const PlayAudioCommandSchema = z.object({
  type: z.literal("play_audio"),
  /** Opaque identifier for the audio stream delivered out of band. */
  streamId: z.string().min(1),
});
export type PlayAudioCommand = z.infer<typeof PlayAudioCommandSchema>;

// ---------------------------------------------------------------------------
// leave
// ---------------------------------------------------------------------------

/** Ask the bot to leave the meeting it is currently in. */
export const LeaveCommandSchema = z.object({
  type: z.literal("leave"),
  /** Optional human-readable reason, surfaced in logs/telemetry. */
  reason: z.string().optional(),
});
export type LeaveCommand = z.infer<typeof LeaveCommandSchema>;

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/** Request a status snapshot from the bot (lifecycle + participants). */
export const StatusCommandSchema = z.object({
  type: z.literal("status"),
});
export type StatusCommand = z.infer<typeof StatusCommandSchema>;

// ---------------------------------------------------------------------------
// MeetBotCommand — discriminated union
// ---------------------------------------------------------------------------

/**
 * Every inbound command accepted by the meet-bot is one of these shapes.
 * Consumers should parse incoming payloads with this schema to both
 * validate and narrow on `type`.
 */
export const MeetBotCommandSchema = z.discriminatedUnion("type", [
  SendChatCommandSchema,
  PlayAudioCommandSchema,
  LeaveCommandSchema,
  StatusCommandSchema,
]);
export type MeetBotCommand = z.infer<typeof MeetBotCommandSchema>;

/** All command `type` discriminator values as a const tuple. */
export const MEET_BOT_COMMAND_TYPES = [
  "send_chat",
  "play_audio",
  "leave",
  "status",
] as const;

export type MeetBotCommandType = (typeof MEET_BOT_COMMAND_TYPES)[number];
