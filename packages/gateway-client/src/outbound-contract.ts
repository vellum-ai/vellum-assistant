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
  /**
   * What the recipient is being asked to do, so a renderer can head the card
   * with the right verb. Resolved once by the producer; a renderer that reads
   * the actions to work it out would be parsing a payload it is meant only to
   * draw. Absent means an approval, which is what every existing producer
   * sends and what a renderer without this field already assumes.
   */
  intent: z.enum(["approval", "question"]).optional(),
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
  /**
   * The organization the reader belongs to, for a channel whose user ids are
   * only unique within one.
   *
   * Not every channel federates. Telegram and Discord user ids are global and
   * ignore this; Slack ids are scoped to a workspace, and a guest reaching a
   * shared channel from another one is only identified by the pair. A channel
   * that needs it and does not get it cannot address the reader, so it treats
   * the audience as unexpressible rather than guessing.
   */
  userOrgId: z.string().optional(),
});

export type MessageAudience = z.infer<typeof MessageAudienceSchema>;

// ---------------------------------------------------------------------------
// Streaming a reply that grows
// ---------------------------------------------------------------------------

/**
 * One step of a plan carried alongside a growing reply: an ordered,
 * status-bearing unit of work the assistant reports while a turn runs.
 *
 * The vocabulary is the assistant's own `task_progress` surface rather than any
 * channel's, so a channel that renders plans natively converts on its way out
 * and a channel that cannot writes them as text. Slack's `task_update` chunk
 * spells two of these statuses differently and its transport translates.
 */
export const StreamPlanStepSchema = z.object({
  label: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]),
  detail: z.string().optional(),
});

export type StreamPlanStep = z.infer<typeof StreamPlanStepSchema>;

/** A plan shown with a growing reply: an optional title over ordered steps. */
export const StreamPlanSchema = z.object({
  title: z.string().optional(),
  steps: z.array(StreamPlanStepSchema),
});

export type StreamPlan = z.infer<typeof StreamPlanSchema>;

/**
 * One operation on a reply that grows while the turn runs.
 *
 * Channels that can do this disagree on what the growing thing *is*, and the
 * split is preview versus persist. Slack streams the reply itself:
 * `chat.startStream` opens the message that will remain, and `chat.stopStream`
 * finalizes it in place. Telegram streams a live draft, which is ephemeral,
 * expires on its own, and never becomes the reply; the reply is persisted
 * afterwards by an ordinary send. Discord has no primitive for either and
 * omits `streamReply`, so the caller sends the finished reply and nothing is
 * simulated on its behalf.
 *
 * That is why every operation carries both `text`, the whole of what the reply
 * now reads as, and `appended`, only what is new since the last operation.
 * Slack's append takes the delta; Telegram's draft takes the partial text and
 * lets its clients animate the difference. Neither channel has to know which
 * kind the other is, and a third can read whichever it needs.
 *
 * `text` is required on every operation because a channel that rewrites needs
 * it on every one, and it is what the reply reads as rather than what this
 * operation changed: absent is never the right answer, where empty can be.
 * `appended` is what moved, so it is absent when only the plan did.
 *
 * `start` opens the growing reply and returns a `streamId` in the channel's
 * own id space; `append` advances it; `stop` ends it. What `stop` leaves
 * behind differs by channel, which is why it carries the complete reply rather
 * than a remainder: a channel that finalized in place has already shown it,
 * and a channel whose preview evaporates needs it to send the real message.
 */
export const StreamOpSchema = z
  .discriminatedUnion("action", [
    z.object({
      action: z.literal("start"),
      /**
       * The message this reply grows under, in the channel's own id space.
       *
       * Slack requires one: `chat.startStream` streams into a thread, and
       * omitting it is only accepted where a whole channel is one session. A
       * channel that threads nothing ignores it.
       */
      anchorMessageId: z.string().optional(),
      text: z.string(),
      appended: z.string().optional(),
      plan: StreamPlanSchema.optional(),
      /**
       * Who may see the growing reply. Absent means everyone in the room, the
       * same reading the finished reply gives it.
       */
      audience: MessageAudienceSchema.optional(),
    }),
    z.object({
      action: z.literal("append"),
      /** The open reply, in the channel's own id space. */
      streamId: z.string(),
      text: z.string(),
      appended: z.string().optional(),
      plan: StreamPlanSchema.optional(),
    }),
    z.object({
      action: z.literal("stop"),
      streamId: z.string(),
      /**
       * The complete reply, not the remainder. A channel whose preview
       * evaporates sends this as the message that stays; one that finalizes
       * its stream in place has already shown it and appends `appended`.
       */
      text: z.string(),
      appended: z.string().optional(),
      plan: StreamPlanSchema.optional(),
    }),
  ])
  .superRefine((op, ctx) => {
    // An operation has to move something: new words, or the plan beside them.
    // `text` alone cannot, since it restates what the reply already reads as.
    // Slack rejects a start or append carrying neither, and a channel that
    // rewrites would spend an edit redrawing what is already on screen.
    if (
      (op.action === "start" || op.action === "append") &&
      op.appended === undefined &&
      op.plan === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${op.action} requires appended or plan`,
      });
    }
  });

export type StreamOp = z.infer<typeof StreamOpSchema>;

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
