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
  // Surface-agnostic button weight. Renderers translate it to their platform
  // token (Slack primary/danger, Surface primary/destructive); absent means
  // the renderer applies its own default styling.
  emphasis: z.enum(["primary", "secondary", "destructive"]).optional(),
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

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------

/**
 * Restricts a message to a single reader in a room that has more.
 *
 * A single object rather than a flag beside an id, because the two are only
 * meaningful together: a channel cannot address one reader without knowing
 * which. Slack reads this as `chat.postEphemeral`; a channel whose rooms hold
 * one reader already has nothing to do.
 */
export const MessageAudienceSchema = z.object({
  kind: z.literal("oneReader"),
  /** The reader, in the channel's own id space. */
  userId: z.string(),
});

export type MessageAudience = z.infer<typeof MessageAudienceSchema>;

// ---------------------------------------------------------------------------
// Channel reply payload — the full outbound wire format
// ---------------------------------------------------------------------------

export const ChannelReplyPayloadSchema = z.object({
  chatId: z.string(),
  text: z.string().optional(),
  assistantId: z.string().optional(),
  attachments: z.array(AttachmentMetadataSchema).optional(),
  approval: ApprovalUIMetadataSchema.optional(),
  /**
   * Who may see this message. Absent means everyone in the room, which is the
   * only safe reading of an absent value: a message meant for one reader that
   * loses its audience must not become a public one.
   */
  audience: MessageAudienceSchema.optional(),
  /**
   * Asks the channel to render the text richly rather than as plain text.
   * Each channel decides what that means, and one that cannot ignores it.
   * Slack is the only channel acting on it today, where it becomes Block Kit.
   */
  renderRichly: z.boolean().optional(),
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
