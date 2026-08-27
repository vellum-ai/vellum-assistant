/**
 * Content-type classification for local files referenced from chat markdown.
 *
 * The bytes decide. A filename extension is a claim the author makes and the
 * daemon's content endpoint derives its `Content-Type` from that same claim, so
 * neither is trustworthy on its own: a `.png` holding a zip archive must render
 * as a file card, not a broken `<img>`. Magic-byte sniffing over the first
 * bytes of the file settles it, and the extension only fills in for formats
 * that carry no usable signature.
 */

export type LocalFileKind = "image" | "audio" | "video" | "pdf" | "file";

/** Extensions whose type we can name without reading the bytes. */
const EXTENSION_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/mp4",
  webm: "video/webm",
  pdf: "application/pdf",
};

/**
 * Office Open XML formats. Every one of these is a zip package, so the bytes
 * only ever sniff as `application/zip` and the extension is what names the
 * actual format.
 */
const OOXML_MIME_TYPES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * Types that name no format, so they must not shadow what the filename or the
 * bytes say. An empty type is the same claim made by saying nothing.
 */
export const GENERIC_MIME_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);

/** Bytes scanned for the Matroska DocType string. */
const MATROSKA_DOCTYPE_SCAN_BYTES = 256;

/** Bytes decoded when testing for an SVG document. */
const TEXT_SNIFF_BYTES = 1024;

function matchesSignature(
  bytes: Uint8Array,
  signature: readonly number[],
  offset = 0,
): boolean {
  if (bytes.length < offset + signature.length) {
    return false;
  }
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) {
      return false;
    }
  }
  return true;
}

/** Latin-1 view of a byte window, for the ascii tags formats embed. */
function asciiSlice(bytes: Uint8Array, offset: number, length: number): string {
  const end = Math.min(bytes.length, offset + length);
  let out = "";
  for (let i = offset; i < end; i += 1) {
    out += String.fromCharCode(bytes[i]!);
  }
  return out;
}

/** MPEG audio frame header: sync bits, a real version, and a real layer. */
function isMpegAudioFrameHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 2) {
    return false;
  }
  const first = bytes[0]!;
  const second = bytes[1]!;
  if (first !== 0xff || (second & 0xe0) !== 0xe0) {
    return false;
  }
  const version = (second >> 3) & 0x03;
  const layer = (second >> 1) & 0x03;
  return version !== 0x01 && layer !== 0x00;
}

/** ISO base media brand at offset 8 of an `ftyp` box. */
function mimeTypeForIsoBrand(brand: string): string {
  const normalized = brand.trim().toLowerCase();
  if (
    normalized.startsWith("m4a") ||
    normalized.startsWith("m4b") ||
    normalized.startsWith("m4p") ||
    normalized.startsWith("f4a")
  ) {
    return "audio/mp4";
  }
  if (normalized.startsWith("qt")) {
    return "video/quicktime";
  }
  return "video/mp4";
}

/**
 * SVG carries no magic bytes, so it is recognized as markup: text whose first
 * non-whitespace character is `<` and which names an `svg` element. Markup that
 * is not svg-ish stays inconclusive so the extension or server type decides.
 */
function sniffMarkup(bytes: Uint8Array): string | null {
  const text = new TextDecoder("utf-8").decode(
    bytes.subarray(0, TEXT_SNIFF_BYTES),
  );
  const trimmed = text.replace(/^\uFEFF/, "").trimStart();
  if (!trimmed.startsWith("<")) {
    return null;
  }
  return /<svg\b/i.test(trimmed) ? "image/svg+xml" : null;
}

/**
 * Magic-byte sniffing over the first bytes of a file. Returns null when
 * inconclusive.
 */
export function sniffMimeType(bytes: Uint8Array): string | null {
  if (bytes.length === 0) {
    return null;
  }

  if (
    matchesSignature(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return "image/png";
  }
  if (matchesSignature(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  const gifTag = asciiSlice(bytes, 0, 6);
  if (gifTag === "GIF87a" || gifTag === "GIF89a") {
    return "image/gif";
  }
  if (asciiSlice(bytes, 0, 4) === "RIFF") {
    const form = asciiSlice(bytes, 8, 4);
    if (form === "WEBP") {
      return "image/webp";
    }
    if (form === "WAVE") {
      return "audio/wav";
    }
  }
  if (asciiSlice(bytes, 0, 4) === "%PDF") {
    return "application/pdf";
  }
  if (asciiSlice(bytes, 0, 3) === "ID3") {
    return "audio/mpeg";
  }
  if (asciiSlice(bytes, 4, 4) === "ftyp") {
    return mimeTypeForIsoBrand(asciiSlice(bytes, 8, 4));
  }
  if (matchesSignature(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    const head = asciiSlice(bytes, 0, MATROSKA_DOCTYPE_SCAN_BYTES);
    return head.includes("webm") ? "video/webm" : "video/x-matroska";
  }
  if (asciiSlice(bytes, 0, 4) === "OggS") {
    return "audio/ogg";
  }
  if (asciiSlice(bytes, 0, 4) === "fLaC") {
    return "audio/flac";
  }
  if (matchesSignature(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return "application/zip";
  }
  if (matchesSignature(bytes, [0x42, 0x4d])) {
    return "image/bmp";
  }
  if (isMpegAudioFrameHeader(bytes)) {
    return "audio/mpeg";
  }
  return sniffMarkup(bytes);
}

/**
 * Bytes read to classify a blob by signature: enough for every signature
 * {@link sniffMimeType} tests (the Matroska DocType scan is the deepest) while
 * still being a single small read out of a multi-megabyte file.
 */
const SIGNATURE_SNIFF_BYTES = 256;

/**
 * Type of a blob's leading bytes, or null when they match no known signature.
 *
 * Asks the bytes rather than the blob's `type` or name, which a browser derives
 * from the filename extension: a HEIC photo renamed `.png` reports `image/png`
 * and passes a file input's `accept` filter untouched.
 */
export async function sniffBlobMimeType(blob: Blob): Promise<string | null> {
  const head = await blob.slice(0, SIGNATURE_SNIFF_BYTES).arrayBuffer();
  return sniffMimeType(new Uint8Array(head));
}

/** A media type without its parameters, lowercased: `image/jpeg; q=0.8` reads as `image/jpeg`. */
export function baseMimeType(raw: string): string {
  return raw.split(";")[0]!.trim().toLowerCase();
}

function normalizeMimeType(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  const mime = baseMimeType(raw);
  return mime.length > 0 ? mime : null;
}

/**
 * A filename's extension, lowercased, or `""` where it has none.
 *
 * Reads only the last path segment, so a directory named `photos.2024` does not
 * lend its suffix to a dotless file inside it, and a leading dot names a hidden
 * file rather than an extension.
 */
export function extensionOf(filename: string): string {
  const base = filename.slice(filename.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return "";
  }
  return base
    .slice(dot + 1)
    .trim()
    .toLowerCase();
}

function kindForMimeType(mime: string | null): LocalFileKind {
  if (!mime) {
    return "file";
  }
  if (mime.startsWith("image/")) {
    return "image";
  }
  if (mime.startsWith("audio/")) {
    return "audio";
  }
  if (mime.startsWith("video/")) {
    return "video";
  }
  if (mime === "application/pdf") {
    return "pdf";
  }
  return "file";
}

/**
 * Combine sniffed mime, server-reported (extension-based) mime, and filename
 * into a final mime + rendering kind. Sniffed mime wins on mismatch, except
 * where a signature is too coarse to name the format on its own: markup that
 * may or may not be svg, and the zip envelope shared by every OOXML document.
 */
export function resolveLocalFileType(opts: {
  sniffedMime: string | null;
  serverMime: string | null;
  filename: string;
}): { mime: string | null; kind: LocalFileKind } {
  const extension = extensionOf(opts.filename);
  const extensionMime = EXTENSION_MIME_TYPES[extension] ?? null;
  const sniffed = normalizeMimeType(opts.sniffedMime);
  // Markup only counts as an image when the filename agrees; an `.html` file
  // holding an inline `<svg>` is still a document.
  const svgShadowsDocument = sniffed === "image/svg+xml" && extension !== "svg";
  // An OOXML package is a zip, so `application/zip` is what its bytes always
  // say. Naming the real format keeps the document previews reachable while
  // still letting a genuine mismatch (a `.docx` holding png bytes) win.
  const ooxmlMime =
    sniffed === "application/zip"
      ? (OOXML_MIME_TYPES[extension] ?? null)
      : null;
  const trustedSniff = svgShadowsDocument ? null : (ooxmlMime ?? sniffed);
  const server = normalizeMimeType(opts.serverMime);
  const namedServer = server && !GENERIC_MIME_TYPES.has(server) ? server : null;

  const mime = trustedSniff ?? namedServer ?? extensionMime ?? server ?? null;
  return { mime, kind: kindForMimeType(mime) };
}
