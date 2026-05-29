import type { DisplayAttachment } from "@/types/attachment-types";

// Single attachment summary line emitted by the runtime daemon when echoing
// history (see vellum-assistant `daemon/handlers/shared.ts`
// `renderFileBlockForHistory`):
//
//     [File attachment] <filename>, type=<mime>[, size=<human-readable>]
//
// Optional `Attachment text: …` lines may follow when the daemon extracted
// text from the file; we discard those — they are LLM context, not user copy.
const ATTACHMENT_LINE_RE =
  /^\[File attachment\] (.+?), type=([^,\n]+?)(?:, size=([^\n]+))?$/;

const SIZE_RE = /^([\d.]+)\s*(B|KB|MB|GB)$/;

function parseHumanReadableSize(s: string): number {
  const m = SIZE_RE.exec(s.trim());
  if (!m) return 0;
  const value = Number.parseFloat(m[1]!);
  if (!Number.isFinite(value)) return 0;
  switch (m[2]) {
    case "B":
      return Math.round(value);
    case "KB":
      return Math.round(value * 1024);
    case "MB":
      return Math.round(value * 1024 * 1024);
    case "GB":
      return Math.round(value * 1024 * 1024 * 1024);
    default:
      return 0;
  }
}

/**
 * Extract attachment summaries that the runtime daemon inlined into a message's
 * text content on history rehydrate, and return the cleaned user-facing text
 * alongside reconstructed `DisplayAttachment` objects.
 *
 * The daemon appends `[File attachment] …` summary lines to the message body
 * so the LLM has context about attachments. It also returns structured
 * attachment metadata in the `attachments` field (real UUIDs, filenames, etc.).
 * Callers should prefer structured metadata when available and use these
 * parsed stubs only as a last-resort fallback. Either way, the summary lines
 * must be stripped from content to prevent them rendering in the chat bubble.
 *
 * Used by both `history.ts` (initial load) and `reconcile.ts` (periodic
 * server sync) to keep displayed message content clean.
 *
 * The synthesized `id` is prefixed `rehydrated:` so callers can tell these
 * stubs from real upload ids — the modal's `/v1/.../attachments/{id}/content`
 * fetch will 404 against a rehydrated id and fall through to its error state.
 */
export function parseAttachmentSummariesFromContent(content: string): {
  cleanedContent: string;
  attachments: DisplayAttachment[] | undefined;
} {
  const marker = "[File attachment] ";
  const idx = content.indexOf(marker);
  if (idx < 0) return { cleanedContent: content, attachments: undefined };

  // Only treat the marker as a summary block when it starts at line boundary —
  // otherwise it's just user text that happens to mention the phrase.
  const startsAtLineStart = idx === 0 || content[idx - 1] === "\n";
  if (!startsAtLineStart) {
    return { cleanedContent: content, attachments: undefined };
  }

  const cleanedContent =
    idx > 0 && content[idx - 1] === "\n"
      ? content.slice(0, idx - 1)
      : content.slice(0, idx);

  const attachments: DisplayAttachment[] = [];
  for (const line of content.slice(idx).split("\n")) {
    const match = ATTACHMENT_LINE_RE.exec(line);
    if (!match) continue;
    const [, filename, mimeType, sizeStr] = match;
    attachments.push({
      id: `rehydrated:${attachments.length}`,
      filename: filename!,
      mimeType: mimeType!,
      sizeBytes: sizeStr ? parseHumanReadableSize(sizeStr) : 0,
      previewUrl: null,
    });
  }

  return {
    cleanedContent,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}
