import { z } from "zod";

/**
 * What every channel's connect/disconnect handler answers, whatever the
 * channel.
 *
 * Each channel's own schema extends this with its tail: Slack carries a
 * workspace and a thread mode, Telegram a webhook secret and registered
 * commands, Discord nothing. The shape is the same one the readiness probes
 * have, a declared common part plus a per-channel remainder, and it exists so
 * a caller can ask "is this connected" without knowing which channel it is.
 *
 * `connected` is the field that makes this worth extracting. Holding a
 * credential and having a working connection are different questions, and a
 * channel that answered only the first would read as set up while delivering
 * nothing.
 */
export const ChannelConfigResultBaseSchema = z.object({
  /** Whether the operation itself succeeded. */
  success: z.boolean(),
  /** Whether a bot credential is stored, regardless of this call. */
  hasBotToken: z.boolean(),
  /** Whether the channel is actually connected, not merely credentialled. */
  connected: z.boolean(),
  error: z.string().optional(),
});

export type ChannelConfigResultBase = z.infer<
  typeof ChannelConfigResultBaseSchema
>;
