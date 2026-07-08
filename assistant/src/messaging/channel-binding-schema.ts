import { z } from "zod";

/** Channel-neutral deep-link pair into an external client: a native app URL
 *  (e.g. `slack://…`) and/or a browser URL. */
const externalSourceLinkSchema = z.object({
  appUrl: z.string().optional(),
  webUrl: z.string().optional(),
});

const slackThreadSchema = z.object({
  channelId: z.string(),
  threadTs: z.string(),
  link: externalSourceLinkSchema.optional(),
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
  /** Deep link back to the conversation's source in the external channel —
   *  the specific thread when the binding has one, otherwise the chat or
   *  channel. Channel-neutral: any channel whose binding-metadata builder can
   *  produce links emits it (currently Slack only), and clients can render an
   *  "open in source" affordance without channel-specific logic. */
  sourceLink: externalSourceLinkSchema.optional(),
});

type ChannelBinding = z.infer<typeof channelBindingSchema>;

/**
 * The channel-specific fields a per-channel builder contributes to a binding
 * (everything beyond the channel-neutral base). Picked from the schema above
 * so a builder's output can never drift from the wire contract.
 */
export type ChannelBindingMetadata = Pick<
  ChannelBinding,
  "externalChatName" | "slackThread" | "slackChannel" | "sourceLink"
>;
