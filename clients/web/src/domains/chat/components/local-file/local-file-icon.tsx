/**
 * Per-kind lucide icon for a local file reference, matching the icon surface
 * the attachment chips and squares use.
 *
 * A classified media kind maps straight across; everything else is refined by
 * filename so a spreadsheet, archive, or source file gets its own glyph
 * instead of the generic file page.
 */

import {
  ATTACHMENT_ICON_BY_KIND,
  classifyAttachment,
  type AttachmentIconKind,
} from "@/domains/chat/components/chat-attachments/utils";
import {
  type LocalFileKind,
  resolveLocalFileType,
} from "@/domains/chat/utils/mime-sniff";

/** Icon bucket for a classified local file. */
export function localFileIconKind(
  kind: LocalFileKind,
  filename: string,
): AttachmentIconKind {
  if (kind !== "file") {
    return kind;
  }
  return classifyAttachment("", filename);
}

/**
 * Rendering kind guessed from the filename alone, for surfaces that show a
 * reference without probing its bytes.
 */
export function localFileKindFromFilename(filename: string): LocalFileKind {
  return resolveLocalFileType({
    sniffedMime: null,
    serverMime: null,
    filename,
  }).kind;
}

interface LocalFileIconProps {
  kind: LocalFileKind;
  filename: string;
  className?: string;
}

export function LocalFileIcon({
  kind,
  filename,
  className,
}: LocalFileIconProps) {
  const Icon = ATTACHMENT_ICON_BY_KIND[localFileIconKind(kind, filename)];
  return <Icon className={className} aria-hidden />;
}
