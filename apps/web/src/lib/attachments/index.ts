import { createHash } from "node:crypto";
import path from "node:path";
import { TextDecoder } from "node:util";

export type AttachmentKind = "image" | "document";

export interface ProcessedAttachment {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  kind: AttachmentKind;
  extractedText: string | null;
}

export interface AttachmentFallbackInput {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: AttachmentKind;
  extractedText: string | null;
}

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv",
]);

const OFFICE_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const PDF_MIME_TYPE = "application/pdf";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const PER_FILE_TEXT_LIMIT = 8_000;
const AGGREGATE_TEXT_LIMIT = 24_000;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

function normalizeMimeType(mimeType: string): string {
  return mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
}

function isAllowedMimeType(mimeType: string): boolean {
  return IMAGE_MIME_TYPES.has(mimeType)
    || TEXT_MIME_TYPES.has(mimeType)
    || OFFICE_MIME_TYPES.has(mimeType)
    || mimeType === PDF_MIME_TYPE;
}

function isImageMimeType(mimeType: string): boolean {
  return IMAGE_MIME_TYPES.has(mimeType);
}

function isOfficeMimeType(mimeType: string): boolean {
  return OFFICE_MIME_TYPES.has(mimeType);
}

function isZipSignature(buffer: Buffer): boolean {
  return buffer.length >= 4
    && buffer[0] === 0x50
    && buffer[1] === 0x4b
    && buffer[2] === 0x03
    && buffer[3] === 0x04;
}

function detectMimeTypeFromSignature(buffer: Buffer): string | null {
  if (buffer.length < 4) {
    return null;
  }

  // PNG
  if (
    buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // GIF
  if (
    buffer.length >= 6
    && buffer.toString("ascii", 0, 6) === "GIF87a"
  ) {
    return "image/gif";
  }
  if (
    buffer.length >= 6
    && buffer.toString("ascii", 0, 6) === "GIF89a"
  ) {
    return "image/gif";
  }

  // WebP
  if (
    buffer.length >= 12
    && buffer.toString("ascii", 0, 4) === "RIFF"
    && buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  // PDF
  if (buffer.length >= 5 && buffer.toString("ascii", 0, 5) === "%PDF-") {
    return "application/pdf";
  }

  if (isZipSignature(buffer)) {
    return "application/zip";
  }

  return null;
}

function ensureSignatureIsCompatible(
  resolvedMimeType: string,
  extensionMimeType: string | undefined,
  signatureMimeType: string | null,
): void {
  if (isImageMimeType(resolvedMimeType) || resolvedMimeType === PDF_MIME_TYPE) {
    if (signatureMimeType !== resolvedMimeType) {
      throw new Error(`File signature does not match ${resolvedMimeType}`);
    }
  }

  if (isOfficeMimeType(resolvedMimeType)) {
    if (signatureMimeType !== "application/zip") {
      throw new Error("Office files must have a valid ZIP signature");
    }
    if (!extensionMimeType || extensionMimeType !== resolvedMimeType) {
      throw new Error("Office files must use a valid .docx/.xlsx/.pptx extension");
    }
  }

  if (TEXT_MIME_TYPES.has(resolvedMimeType) && signatureMimeType && !TEXT_MIME_TYPES.has(signatureMimeType)) {
    throw new Error("Text file appears to contain binary content");
  }
}

function resolveMimeType(
  fileName: string,
  declaredMimeType: string,
  signatureMimeType: string | null,
): string {
  const extension = path.extname(fileName).toLowerCase();
  const extensionMimeType = MIME_BY_EXTENSION[extension];
  const normalizedDeclared = normalizeMimeType(declaredMimeType);

  let resolved = "";
  if (signatureMimeType && signatureMimeType !== "application/zip") {
    resolved = signatureMimeType;
  } else if (extensionMimeType) {
    resolved = extensionMimeType;
  } else if (isAllowedMimeType(normalizedDeclared)) {
    resolved = normalizedDeclared;
  }

  if (!resolved || !isAllowedMimeType(resolved)) {
    throw new Error(`Unsupported file type for "${fileName}"`);
  }

  ensureSignatureIsCompatible(resolved, extensionMimeType, signatureMimeType);
  return resolved;
}

function normalizeExtractedText(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

async function extractPdfText(buffer: Buffer): Promise<string | null> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  try {
    const parsed = await parser.getText();
    return parsed.text ?? null;
  } finally {
    await parser.destroy();
  }
}

async function extractDocxText(buffer: Buffer): Promise<string | null> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  return result.value || null;
}

async function extractXlsxText(buffer: Buffer): Promise<string | null> {
  const xlsx = await import("xlsx");
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const parts: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      continue;
    }
    const csvText = xlsx.utils.sheet_to_csv(sheet).trim();
    if (csvText) {
      parts.push(`[Sheet: ${sheetName}]`);
      parts.push(csvText);
    }
  }

  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n\n");
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

async function extractPptxText(buffer: Buffer): Promise<string | null> {
  const jszip = await import("jszip");
  const zip = await jszip.default.loadAsync(buffer);
  const parts: string[] = [];

  const slideEntries = Object.keys(zip.files)
    .filter((fileName) => /^ppt\/slides\/slide\d+\.xml$/i.test(fileName))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  for (const slideName of slideEntries) {
    const slide = zip.file(slideName);
    if (!slide) {
      continue;
    }
    const xml = await slide.async("text");
    const matches = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)];
    const texts = matches.map((match) => decodeXmlEntities(match[1] ?? "").trim()).filter(Boolean);
    if (texts.length > 0) {
      parts.push(`[Slide: ${slideName.split("/").pop()}]`);
      parts.push(texts.join("\n"));
    }
  }

  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n\n");
}

function extractTextFromUtf8(buffer: Buffer): string | null {
  let decoded = "";
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
  const normalized = normalizeExtractedText(decoded);
  return normalized.length > 0 ? normalized : null;
}

export async function extractTextForAttachment(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<string | null> {
  try {
    let extracted: string | null = null;

    if (TEXT_MIME_TYPES.has(mimeType)) {
      extracted = extractTextFromUtf8(buffer);
    } else if (mimeType === PDF_MIME_TYPE) {
      extracted = await extractPdfText(buffer);
    } else if (mimeType === MIME_BY_EXTENSION[".docx"]) {
      extracted = await extractDocxText(buffer);
    } else if (mimeType === MIME_BY_EXTENSION[".xlsx"]) {
      extracted = await extractXlsxText(buffer);
    } else if (mimeType === MIME_BY_EXTENSION[".pptx"]) {
      extracted = await extractPptxText(buffer);
    } else if (mimeType.startsWith("text/")) {
      extracted = extractTextFromUtf8(buffer);
    }

    if (!extracted) {
      return null;
    }

    return truncateText(normalizeExtractedText(extracted), PER_FILE_TEXT_LIMIT);
  } catch (error) {
    console.warn(`[attachments] Failed to extract text from ${fileName}:`, error);
    return null;
  }
}

export async function processAttachmentUpload(
  fileName: string,
  declaredMimeType: string,
  buffer: Buffer,
): Promise<ProcessedAttachment> {
  const signatureMimeType = detectMimeTypeFromSignature(buffer);
  const mimeType = resolveMimeType(fileName, declaredMimeType, signatureMimeType);
  const kind: AttachmentKind = isImageMimeType(mimeType) ? "image" : "document";

  const maxBytes = kind === "image" ? IMAGE_MAX_BYTES : DOCUMENT_MAX_BYTES;
  if (buffer.byteLength > maxBytes) {
    const maxMb = Math.floor(maxBytes / (1024 * 1024));
    throw new Error(`File "${fileName}" exceeds ${maxMb}MB limit for ${kind} attachments`);
  }

  const extractedText = kind === "document"
    ? await extractTextForAttachment(buffer, mimeType, fileName)
    : null;

  return {
    fileName,
    mimeType,
    sizeBytes: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    kind,
    extractedText,
  };
}

export function sanitizeFilename(fileName: string): string {
  return fileName
    .trim()
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 180) || "attachment";
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  const kb = sizeBytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function buildAttachmentFallbackText(attachments: AttachmentFallbackInput[]): string {
  if (attachments.length === 0) {
    return "";
  }

  const manifest = attachments.map((attachment, index) => (
    `${index + 1}. ${attachment.fileName} (${attachment.mimeType}, ${formatBytes(attachment.sizeBytes)})`
  ));

  const lines: string[] = [
    "[Attachment context]",
    "The user included file attachments with this message.",
    "",
    "Attachment manifest:",
    ...manifest,
  ];

  const imageCount = attachments.filter((attachment) => attachment.kind === "image").length;
  if (imageCount > 0) {
    lines.push("");
    lines.push(
      `${imageCount} image attachment(s) were included. Visual interpretation is deferred in this runtime path.`,
    );
  }

  const docsWithText = attachments
    .filter((attachment) => attachment.kind === "document" && attachment.extractedText)
    .map((attachment) => ({ ...attachment, extractedText: attachment.extractedText as string }));

  if (docsWithText.length > 0) {
    lines.push("");
    lines.push("Extracted text snippets from attached documents:");

    let remaining = AGGREGATE_TEXT_LIMIT;
    for (const attachment of docsWithText) {
      if (remaining <= 0) {
        break;
      }
      const snippet = truncateText(attachment.extractedText, remaining);
      remaining -= snippet.length;
      lines.push("");
      lines.push(`--- ${attachment.fileName} ---`);
      lines.push(snippet);
    }
  }

  lines.push("");
  lines.push("[End attachment context]");
  return lines.join("\n");
}
