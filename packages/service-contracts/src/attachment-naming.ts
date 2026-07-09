/**
 * Attachment filename contract shared by the daemon (which materializes
 * `vellum://` links and `<vellum-attachment>` directives into stored
 * attachments) and the web client (which resolves clicked links back to
 * those attachments). Both sides must agree on the stored filename, so the
 * naming rule lives here once.
 */

const EXTENSION_MIME_MAP: Record<string, string> = {
  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",

  // Documents
  pdf: "application/pdf",
  json: "application/json",
  xml: "application/xml",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  ts: "text/typescript",

  // Audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/x-m4a",
  opus: "audio/opus",

  // Video
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mpeg: "video/mpeg",

  // Archives
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
};

/**
 * Infer a MIME type from a filename extension.
 * Returns `application/octet-stream` when the extension is unrecognised.
 */
export function inferMimeType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) {
    return "application/octet-stream";
  }
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXTENSION_MIME_MAP[ext] ?? "application/octet-stream";
}

/**
 * Pick the stored attachment filename for a materialized file directive.
 *
 * Explicit filenames (`<vellum-attachment filename="..." />` attributes)
 * are an authoring contract and always used verbatim. Link display text
 * (`[label](vellum://...)`) is cosmetic: it is only honored as the filename
 * when it carries a recognized extension. Bare labels
 * (e.g. `[desktop](vellum://.../shot.png)`) would otherwise produce
 * extensionless downloads with an `application/octet-stream` MIME type,
 * which macOS opens as raw text. In that case the real path basename wins.
 *
 * Paths are treated as POSIX (`/`-separated): sandbox paths always are, and
 * `vellum://` URLs use `/` on every platform.
 */
export function resolveAttachmentFilename(
  preferred: string | undefined,
  resolvedPath: string,
  filenameSource: "explicit" | "label" = "explicit",
): string {
  const fallback = resolvedPath.split("/").pop() ?? resolvedPath;
  if (!preferred) {
    return fallback;
  }
  if (filenameSource === "explicit") {
    return preferred;
  }
  if (inferMimeType(preferred) !== "application/octet-stream") {
    return preferred;
  }
  return fallback;
}
