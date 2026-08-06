/**
 * `document_editor_show` SSE event.
 *
 * Server → client instruction to open the document editor for a
 * surface, emitted by the document tool. Carries the owning
 * `conversationId`, the `surfaceId` to bind the editor to, the
 * `title`, and the `initialContent` to seed it with.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const DocumentEditorShowEventSchema = z.object({
  type: z.literal("document_editor_show"),
  conversationId: z.string(),
  surfaceId: z.string(),
  title: z.string(),
  initialContent: z.string(),
});

export type DocumentEditorShowEvent = z.infer<
  typeof DocumentEditorShowEventSchema
>;
