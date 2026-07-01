/**
 * Daemon → gateway outbound delivery contract.
 *
 * Zod schemas defining the wire format for channel replies delivered from
 * the daemon to the gateway via `POST /deliver/{channel}`. Both services
 * import from here so the contract is enforced at compile time.
 *
 * The daemon constructs these payloads in `deliverChannelReply()` and
 * `deliverApprovalPrompt()`; the gateway validates and dispatches them
 * to the target channel provider.
 */

import type { KnownBlock } from "@slack/types";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Attachment metadata
// ---------------------------------------------------------------------------

export const AttachmentMetadataSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  kind: z.string(),
  data: z.string().optional(),
  thumbnailData: z.string().optional(),
  fileBacked: z.boolean().optional(),
});

export type AttachmentMetadata = z.infer<typeof AttachmentMetadataSchema>;

// ---------------------------------------------------------------------------
// Approval UI types
// ---------------------------------------------------------------------------

export const ApprovalActionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
});

export type ApprovalActionOption = z.infer<typeof ApprovalActionOptionSchema>;

export const PermissionRequestDetailsSchema = z.object({
  toolName: z.string(),
  riskLevel: z.string(),
  toolInput: z.record(z.string(), z.unknown()),
  requesterIdentifier: z.string().optional(),
});

export type PermissionRequestDetails = z.infer<
  typeof PermissionRequestDetailsSchema
>;

export const ApprovalUIMetadataSchema = z.object({
  requestId: z.string(),
  actions: z.array(ApprovalActionOptionSchema),
  plainTextFallback: z.string(),
  permissionDetails: PermissionRequestDetailsSchema.optional(),
});

export type ApprovalUIMetadata = z.infer<typeof ApprovalUIMetadataSchema>;

// ---------------------------------------------------------------------------
// Slack streaming operations
// ---------------------------------------------------------------------------

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
 * body. Blocks are only accepted on `stop` — during the stream, Slack renders
 * the `markdownText` natively.
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
      tasks: z.array(SlackStreamTaskSchema).optional(),
    }),
    z.object({
      action: z.literal("stop"),
      streamTs: z.string(),
      markdownText: z.string().optional(),
      blocks: z.array(z.custom<KnownBlock>()).optional(),
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

// ---------------------------------------------------------------------------
// Channel reply payload — the full outbound wire format
// ---------------------------------------------------------------------------

export const ChannelReplyPayloadSchema = z.object({
  chatId: z.string(),
  text: z.string().optional(),
  /** Pre-formatted Block Kit blocks for Slack delivery. */
  blocks: z.array(z.custom<KnownBlock>()).optional(),
  assistantId: z.string().optional(),
  attachments: z.array(AttachmentMetadataSchema).optional(),
  approval: ApprovalUIMetadataSchema.optional(),
  chatAction: z.literal("typing").optional(),
  /**
   * When true, deliver via `chat.postEphemeral` so only the target `user`
   * sees the message.
   */
  ephemeral: z.boolean().optional(),
  /** Slack user ID — required when `ephemeral` is true. */
  user: z.string().optional(),
  /** When provided, update an existing message instead of posting a new one. */
  messageTs: z.string().optional(),
  /** When true, the daemon generates Block Kit blocks from the text before delivery. */
  useBlocks: z.boolean().optional(),
  /** When provided, add or remove an emoji reaction on a message. */
  reaction: z
    .object({
      action: z.enum(["add", "remove"]),
      name: z.string(),
      messageTs: z.string(),
    })
    .optional(),
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
  /** When provided, perform one Slack streaming operation (start/append/stop). */
  slackStream: SlackStreamOpSchema.optional(),
});

export type ChannelReplyPayload = z.infer<typeof ChannelReplyPayloadSchema>;

// ---------------------------------------------------------------------------
// Channel delivery result — gateway response
// ---------------------------------------------------------------------------

export const ChannelDeliveryResultSchema = z.object({
  ok: z.boolean(),
  /** The message timestamp returned by the delivery endpoint. */
  ts: z.string().optional(),
});

export type ChannelDeliveryResult = z.infer<typeof ChannelDeliveryResultSchema>;
