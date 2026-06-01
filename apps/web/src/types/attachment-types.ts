/** Display metadata for a file attachment (user-uploaded or assistant-generated),
 *  used to render the chip inside a message bubble. For live sessions, populated
 *  from SSE event data via `toDisplayAttachments` (`utils/display-attachments.ts`). For
 *  history reload, populated from the daemon's structured attachment metadata
 *  (real UUIDs that resolve against the content endpoint) or, as a fallback,
 *  reverse-parsed from `[File attachment] …` summary lines in the message text. */
export interface DisplayAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl: string | null;
}
