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
