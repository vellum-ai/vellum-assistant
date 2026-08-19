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

import { z } from "zod";

import { SlackReplyExtrasSchema } from "./slack-reply.js";

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
// Channel reply payload — the full outbound wire format
// ---------------------------------------------------------------------------

export const ChannelReplyPayloadSchema = z.object({
  chatId: z.string(),
  text: z.string().optional(),
  assistantId: z.string().optional(),
  attachments: z.array(AttachmentMetadataSchema).optional(),
  approval: ApprovalUIMetadataSchema.optional(),
  chatAction: z.literal("typing").optional(),
  /**
   * Render the text richly rather than as plain text. Channel-neutral intent,
   * not a Slack one: Slack reads it as Block Kit, Telegram as a rich-message
   * send that degrades to plain text on rejection.
   */
  useBlocks: z.boolean().optional(),
  /**
   * Add or remove an emoji reaction on a message.
   *
   * `messageTs` is Slack's identifier and is the reason this is not yet a
   * channel-neutral field. It stays at the root because reactions are a
   * capability several channels have, so the fix is a neutral message id
   * rather than a move into the Slack extras.
   */
  reaction: z
    .object({
      action: z.enum(["add", "remove"]),
      name: z.string(),
      messageTs: z.string(),
    })
    .optional(),
  /** What a Slack reply carries that no other channel does. */
  slack: SlackReplyExtrasSchema.optional(),
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
