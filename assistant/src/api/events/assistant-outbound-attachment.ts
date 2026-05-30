/**
 * Outbound assistant attachment — the wire shape attached to
 * `message_complete` and `generation_handoff` SSE events when the
 * assistant turn produced files (sandbox writes, host transfers, tool
 * blocks that returned binary content).
 *
 * Shape is the daemon's emit-time projection of `UserMessageAttachment`
 * (see `assistant/src/daemon/message-types/shared.ts`): only the fields
 * built in `conversation-attachments.ts::buildEmittedAttachments` plus
 * fields the daemon explicitly emits to clients (`filePath` for
 * recordings, per #9744) make it onto the wire. Daemon-internal fields
 * not intended for clients (`extractedText`) stay on the daemon side
 * and do not appear here.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const AssistantOutboundAttachmentSchema = z.object({
  /** Storage id assigned by the daemon's attachment store; absent on
   *  in-memory drafts not backed by a stored row. */
  id: z.string().optional(),
  filename: z.string(),
  mimeType: z.string(),
  /** Base64-encoded file bytes. May be empty when `fileBacked` is
   *  true and the client should hydrate via the /content endpoint. */
  data: z.string(),
  sourceType: z.enum(["sandbox_file", "host_file", "tool_block"]).optional(),
  /** Original file size in bytes. Present when `data` was omitted to
   *  keep payloads small. */
  sizeBytes: z.number().optional(),
  /** Base64-encoded JPEG thumbnail. Generated server-side for video
   *  attachments. */
  thumbnailData: z.string().optional(),
  /** True when the attachment is stored on disk and clients should
   *  hydrate via the /content endpoint instead of relying on `data`. */
  fileBacked: z.boolean().optional(),
  /** Local on-disk path for file-backed attachments. Used by the
   *  macOS client to play recordings and render thumbnails directly
   *  from the local file (see #9744 — eliminates the HTTP fetch +
   *  ffmpeg dep for video). Web clients ignore this field. */
  filePath: z.string().optional(),
});

export type AssistantOutboundAttachment = z.infer<
  typeof AssistantOutboundAttachmentSchema
>;
