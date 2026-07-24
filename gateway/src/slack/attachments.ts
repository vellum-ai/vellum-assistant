import type { SlackFile } from "./message-schemas.js";

export function extractSlackAttachments(files: SlackFile[] | undefined): Array<{
  type: "image" | "document";
  fileId: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}> {
  if (!files || files.length === 0) return [];
  return files
    .filter((f) => f.id && (f.url_private_download || f.url_private))
    .map((f) => ({
      type: f.mimetype?.startsWith("image/")
        ? ("image" as const)
        : ("document" as const),
      fileId: f.id,
      fileName: f.name,
      mimeType: f.mimetype,
      fileSize: f.size,
    }));
}

export function extractSlackFileMap(
  files: SlackFile[] | undefined,
): Map<string, SlackFile> | undefined {
  if (!files || files.length === 0) return undefined;
  const downloadableFiles = files.filter(
    (f) => f.id && (f.url_private_download || f.url_private),
  );
  return downloadableFiles.length
    ? new Map(downloadableFiles.map((f) => [f.id, f]))
    : undefined;
}
