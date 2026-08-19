/**
 * Slack's additions to the outbound reply contract.
 *
 * Channel-specific options live in a per-channel object on
 * {@link ChannelReplyPayload} rather than at its root, so the root stays the
 * set of fields every channel genuinely has. `outbound-contract.ts` composes
 * them in by name; a plugin-contributed channel would need that composition to
 * become a registry.
 */

import type { KnownBlock } from "@slack/types";
import { z } from "zod";

/**
 * One task card in a Slack streamed plan. Mirrors the `task_update` chunk of
 * the Slack streaming API: an ordered, status-bearing step the assistant is
 * working through. `title` is capped at 256 characters by Slack.
 *
 * @see https://docs.slack.dev/reference/methods/chat.appendStream/
 */
export const SlackStreamTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["pending", "in_progress", "complete", "error"]),
  details: z.string().optional(),
  output: z.string().optional(),
});

export type SlackStreamTask = z.infer<typeof SlackStreamTaskSchema>;

/**
 * A single Slack streaming operation, mapping directly onto the
 * `chat.startStream` / `chat.appendStream` / `chat.stopStream` Web API methods.
 *
 * `start` opens a streamed reply on a thread and returns the stream `ts`;
 * `append` adds markdown (and optional task cards) to that stream; `stop`
 * finalizes it, optionally rendering rich Block Kit blocks below the streamed
 * body. Blocks are only accepted on `stop` because during the stream Slack
 * renders the `markdownText` natively.
 *
 * @see https://docs.slack.dev/reference/methods/chat.startStream/
 * @see https://docs.slack.dev/reference/methods/chat.appendStream/
 * @see https://docs.slack.dev/reference/methods/chat.stopStream/
 */
export const SlackStreamOpSchema = z
  .discriminatedUnion("action", [
    z.object({
      action: z.literal("start"),
      threadTs: z.string(),
      markdownText: z.string().optional(),
      taskDisplayMode: z.literal("plan").optional(),
      /** Title of the plan block, serialized as a `plan_update` chunk. */
      planTitle: z.string().optional(),
      tasks: z.array(SlackStreamTaskSchema).optional(),
      /**
       * Slack user ID of the reader the stream targets. Required by
       * `chat.startStream` when streaming into a channel; omitted for DMs.
       */
      recipientUserId: z.string().optional(),
      /**
       * Slack team ID the recipient belongs to. Required alongside
       * `recipientUserId` when streaming into a channel; omitted for DMs.
       */
      recipientTeamId: z.string().optional(),
    }),
    z.object({
      action: z.literal("append"),
      streamTs: z.string(),
      markdownText: z.string().optional(),
      /** Title of the plan block, serialized as a `plan_update` chunk. */
      planTitle: z.string().optional(),
      tasks: z.array(SlackStreamTaskSchema).optional(),
    }),
    z.object({
      action: z.literal("stop"),
      streamTs: z.string(),
      markdownText: z.string().optional(),
      blocks: z.array(z.custom<KnownBlock>()).optional(),
      /** Title of the plan block, serialized as a `plan_update` chunk. */
      planTitle: z.string().optional(),
      tasks: z.array(SlackStreamTaskSchema).optional(),
    }),
  ])
  .superRefine((op, ctx) => {
    // Slack requires either `markdown_text` or `chunks` on `start`/`append`; a
    // task-only operation advances the plan block without new body text.
    if (
      (op.action === "start" || op.action === "append") &&
      op.markdownText === undefined &&
      op.tasks === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${op.action} requires markdownText or tasks`,
      });
    }
  });

export type SlackStreamOp = z.infer<typeof SlackStreamOpSchema>;

/**
 * What a Slack reply carries that no other channel does.
 *
 * `messageTs` is Slack's own message identifier, so updating an existing
 * message is expressed here rather than generically: another channel's edit
 * would key on its own id type, and a shared field would have to be a bare
 * string meaning something different per channel.
 */
export const SlackReplyExtrasSchema = z.object({
  /** Pre-formatted Block Kit blocks. */
  blocks: z.array(z.custom<KnownBlock>()).optional(),
  /**
   * When true, deliver via `chat.postEphemeral` so only the target `user`
   * sees the message.
   */
  ephemeral: z.boolean().optional(),
  /** Slack user ID. Required when `ephemeral` is true. */
  user: z.string().optional(),
  /** When provided, update this existing message instead of posting a new one. */
  messageTs: z.string().optional(),
  /** When provided, set or clear the Slack Assistants API thread status. */
  assistantThreadStatus: z
    .object({
      channel: z.string(),
      threadTs: z.string(),
      status: z.string(),
      /** Serialized to Slack as `loading_messages`. */
      loadingMessages: z.array(z.string()).optional(),
    })
    .optional(),
  /** When provided, perform one streaming operation (start/append/stop). */
  stream: SlackStreamOpSchema.optional(),
});

export type SlackReplyExtras = z.infer<typeof SlackReplyExtrasSchema>;

/**
 * Address a Slack reply to one reader, so only that person sees it.
 *
 * `chat.postEphemeral` needs both the flag and the user the message is visible
 * to, and a payload carrying one without the other fails at delivery. Taking
 * the user as a required argument is what makes that pair unrepresentable
 * apart.
 */
export function ephemeralTo(
  user: string,
  extras?: SlackReplyExtras,
): SlackReplyExtras {
  return { ...extras, ephemeral: true, user };
}
