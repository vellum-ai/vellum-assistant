/**
 * `document_editor_update` SSE event.
 *
 * Emitted by the document tool to push new markdown into the client's
 * built-in rich-text editor for an open document surface. Used in place
 * of `document_editor_show` when the surface is already open, so the
 * client replaces content in place instead of reopening (which would
 * clobber unsaved edits).
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const DocumentEditorUpdateEventSchema = z.object({
  type: z.literal("document_editor_update"),
  conversationId: z.string(),
  surfaceId: z.string(),
  markdown: z.string(),
  mode: z.string(),
  /**
   * The document's revision once this content is in place. A client that
   * saves with `baseRevision` adopts it as its new base.
   */
  revision: z.number().optional(),
});

export type DocumentEditorUpdateEvent = z.infer<
  typeof DocumentEditorUpdateEventSchema
>;
