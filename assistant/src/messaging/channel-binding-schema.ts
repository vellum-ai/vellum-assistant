import { z } from "zod";

const slackThreadSchema = z.object({
  channelId: z.string(),
  threadTs: z.string(),
  link: z
    .object({
      appUrl: z.string().optional(),
      webUrl: z.string().optional(),
    })
    .optional(),
});

const slackChannelSchema = z.object({
  channelId: z.string(),
  name: z.string().optional(),
  link: z.object({ webUrl: z.string() }).optional(),
});

/**
 * Wire shape of a serialized conversation channel binding — the single source
 * of truth for this contract.
 *
 * Consumed as a route `responseBody` (which drives `openapi.yaml` generation
 * and, in turn, the web client's generated daemon types), and the server-side
 * builders derive their TypeScript types from it via `z.infer`. The shape is
 * therefore declared exactly once.
 */
export const channelBindingSchema = z.object({
  sourceChannel: z.string(),
  externalChatId: z.string(),
  externalChatName: z.string().optional(),
  externalThreadId: z.string().optional(),
  externalUserId: z.string().nullable(),
  displayName: z.string().nullable(),
  username: z.string().nullable(),
  slackThread: slackThreadSchema.optional(),
  slackChannel: slackChannelSchema.optional(),
});

type ChannelBinding = z.infer<typeof channelBindingSchema>;

/**
 * The channel-specific fields a per-channel builder contributes to a binding
 * (everything beyond the channel-neutral base). Picked from the schema above
 * so a builder's output can never drift from the wire contract.
 */
export type ChannelBindingMetadata = Pick<
  ChannelBinding,
  "externalChatName" | "slackThread" | "slackChannel"
>;
