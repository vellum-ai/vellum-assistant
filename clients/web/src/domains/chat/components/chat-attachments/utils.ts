import {
  baseMimeType,
  extensionOf,
  GENERIC_MIME_TYPES,
} from "@/domains/chat/utils/mime-sniff";

/**
 * Format a raw byte count into a short human-readable string (e.g. "12 KB", "3.4 MB").
 *
 * Mirrors the formatting used by the macOS composer so the two surfaces agree
 * on how attachment sizes render.
 */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted =
    value >= 10 || unitIndex === 0
      ? Math.round(value).toString()
      : value.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}

/**
 * Filename extensions that name an image, for files that arrive without a type.
 *
 * Deliberately wider than the resize whitelist in `attachment-image-resize`.
 * That set answers whether a canvas can downscale a file, which is why it
 * leaves out animated gif and vector svg; those are images all the same, and a
 * caller asking whether to treat a file as an image at all needs both.
 */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
  "bmp",
  "heic",
  "heif",
  "tif",
  "tiff",
]);

/** Whether a lowercased filename extension names an image format. */
function isImageExtension(extension: string): boolean {
  return IMAGE_EXTENSIONS.has(extension);
}

/**
 * Whether an attachment is an image, by its type where it has one and by its
 * filename where it does not.
 *
 * A native picker hands back whatever type the provider published, and an
 * Android provider that publishes none leaves it empty, so `photo.jpg` can
 * arrive typeless. The filename is what settles those, and it is consulted for
 * a file whose type names something generic too, so an image labelled
 * `application/octet-stream` still reads as one.
 */
export function isImageAttachment(file: Pick<File, "name" | "type">): boolean {
  if (file.type.trim().toLowerCase().startsWith("image/")) {
    return true;
  }
  return isImageExtension(extensionOf(file.name));
}

export type AttachmentIconKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "code"
  | "archive"
  | "spreadsheet"
  | "document"
  | "text"
  | "file";

/** The canonical PDF type plus the aliases publishers use in the wild. */
const PDF_MIME_TYPES = new Set([
  "application/pdf",
  "application/x-pdf",
  "application/acrobat",
  "application/vnd.pdf",
  "text/pdf",
  "text/x-pdf",
]);

/**
 * Classify an attachment by its MIME type / filename extension so every surface
 * that renders it agrees on what it is.
 *
 * A declared type wins, compared as the base media type so a parameter such as
 * `; charset=binary` does not hide it. Only where the type names nothing does
 * the filename settle whether the file is an image, so a photo picked as
 * `application/octet-stream` reads as one while a video named `clip.gif` stays
 * a video.
 */
export function classifyAttachment(
  mimeType: string,
  filename: string,
): AttachmentIconKind {
  const mime = baseMimeType(mimeType || "");
  const ext = extensionOf(filename);
  const isGenericMime = GENERIC_MIME_TYPES.has(mime);

  if (mime.startsWith("image/")) {
    return "image";
  }
  if (isGenericMime && isImageExtension(ext)) {
    return "image";
  }
  if (mime.startsWith("video/")) {
    return "video";
  }
  if (mime.startsWith("audio/")) {
    return "audio";
  }
  if (PDF_MIME_TYPES.has(mime) || (isGenericMime && ext === "pdf")) {
    return "pdf";
  }
  if (
    mime === "application/zip" ||
    mime === "application/x-tar" ||
    mime === "application/gzip" ||
    ["zip", "tar", "gz", "tgz", "rar", "7z"].includes(ext)
  ) {
    return "archive";
  }
  if (
    mime === "text/csv" ||
    mime === "application/vnd.ms-excel" ||
    mime ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    ["csv", "xlsx", "xls", "numbers"].includes(ext)
  ) {
    return "spreadsheet";
  }
  if (
    [
      "ts",
      "tsx",
      "js",
      "jsx",
      "py",
      "rb",
      "go",
      "rs",
      "java",
      "kt",
      "swift",
      "c",
      "cc",
      "cpp",
      "h",
      "hpp",
      "sh",
      "bash",
      "zsh",
      "html",
      "css",
      "scss",
      "json",
      "yaml",
      "yml",
      "toml",
      "xml",
    ].includes(ext)
  ) {
    return "code";
  }
  if (
    mime === "application/msword" ||
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ["doc", "docx", "pages"].includes(ext)
  ) {
    return "document";
  }
  if (mime.startsWith("text/") || ["txt", "md", "rtf"].includes(ext)) {
    return "text";
  }
  return "file";
}

/**
 * Estimate the decoded byte length of a base64-encoded string, accounting for
 * trailing `=` padding. Mirrors the daemon's `estimateBase64Bytes` so
 * client-derived sizes for inline tool-result images agree with the sizes the
 * server later assigns to the persisted attachments.
 */
export function estimateBase64Bytes(base64: string): number {
  const trimmed = base64.replace(/\s/g, "");
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding);
}

/**
 * Decode a base64 data URI into a Uint8Array. Returns null if the URI does
 * not contain a recognizable `;base64,` segment.
 */
export function dataUriToUint8Array(
  dataUri: string,
): Uint8Array<ArrayBuffer> | null {
  const match = dataUri.match(/;base64,(.*)$/);
  if (!match?.[1]) {
    return null;
  }
  const binary = atob(match[1]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Truncate a filename down the middle so the extension stays visible. */
export function middleTruncate(filename: string, maxChars = 28): string {
  if (filename.length <= maxChars) {
    return filename;
  }
  const keep = Math.max(4, Math.floor((maxChars - 1) / 2));
  return `${filename.slice(0, keep)}…${filename.slice(filename.length - keep)}`;
}
