/**
 * Assistant outbound attachment types and helpers.
 *
 * Shared DTOs and utilities for building attachment candidates from
 * directives, tool content blocks, and file reads.
 */

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

import {
  hostPolicy,
  sandboxPolicy,
} from "../tools/shared/filesystem/path-policy.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum size in bytes for a single assistant attachment (100 MB). */
export const MAX_ASSISTANT_ATTACHMENT_BYTES = 100 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AttachmentSourceType = "sandbox_file" | "host_file" | "tool_block";

export interface AssistantAttachmentDraft {
  sourceType: AttachmentSourceType;
  filename: string;
  mimeType: string;
  dataBase64: string;
  sizeBytes: number;
  kind: "image" | "video" | "document";
}

// ---------------------------------------------------------------------------
// Base64 size estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the decoded byte length of a base64-encoded string.
 * Accounts for trailing `=` padding characters.
 */
export function estimateBase64Bytes(base64: string): number {
  const trimmed = base64.replace(/\s/g, "");
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding);
}

// ---------------------------------------------------------------------------
// MIME inference
// ---------------------------------------------------------------------------

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
  if (dot === -1) return "application/octet-stream";
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXTENSION_MIME_MAP[ext] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Kind classification
// ---------------------------------------------------------------------------

export function classifyKind(mimeType: string): "image" | "video" | "document" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

// ---------------------------------------------------------------------------
// Validation / cap enforcement
// ---------------------------------------------------------------------------

export interface ValidatedDrafts {
  accepted: AssistantAttachmentDraft[];
  warnings: string[];
}

/**
 * Enforce per-attachment size cap.
 *
 * - Rejects individual drafts that exceed `MAX_ASSISTANT_ATTACHMENT_BYTES`.
 */
export function validateDrafts(
  drafts: AssistantAttachmentDraft[],
): ValidatedDrafts {
  const accepted: AssistantAttachmentDraft[] = [];
  const warnings: string[] = [];

  for (const draft of drafts) {
    if (draft.sizeBytes > MAX_ASSISTANT_ATTACHMENT_BYTES) {
      warnings.push(
        `Skipped attachment "${draft.filename}": ` +
          `size ${formatBytes(draft.sizeBytes)} exceeds ${formatBytes(
            MAX_ASSISTANT_ATTACHMENT_BYTES,
          )} limit.`,
      );
      continue;
    }

    accepted.push(draft);
  }

  return { accepted, warnings };
}

// ---------------------------------------------------------------------------
// Directive parser
// ---------------------------------------------------------------------------

export type DirectiveSource = "sandbox" | "host";

export interface DirectiveRequest {
  source: DirectiveSource;
  path: string;
  filename: string | undefined;
  mimeType: string | undefined;
}

export interface DirectiveParseResult {
  cleanText: string;
  directiveRequests: DirectiveRequest[];
  parseWarnings: string[];
}

export interface DirectiveDisplayDrainResult {
  emitText: string;
  bufferedRemainder: string;
}

/**
 * Match self-closing `<vellum-attachment ... />` tags.
 *
 * Captures the attribute string between the tag name and the `/>` close.
 * Non-greedy so multiple tags on separate lines are matched individually.
 */
const DIRECTIVE_RE = /<vellum-attachment\s+([\s\S]*?)\/>/g;

/**
 * Parse individual attribute key="value" pairs.
 * Supports both double and single quotes.
 */
const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"|(\w+)\s*=\s*'([^']*)'/g;

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw)) != null) {
    const key = m[1] ?? m[3];
    const value = m[2] ?? m[4];
    attrs[key] = value;
  }
  return attrs;
}

/**
 * Scan assistant text for `<vellum-attachment ... />` directives.
 *
 * Returns the text with successfully parsed directives stripped,
 * along with the parsed directive requests and any warnings for
 * malformed tags.
 */
export function parseDirectives(text: string): DirectiveParseResult {
  const directiveRequests: DirectiveRequest[] = [];
  const parseWarnings: string[] = [];

  const cleanText = text.replace(DIRECTIVE_RE, (fullMatch, attrStr: string) => {
    const attrs = parseAttributes(attrStr);

    if (!attrs["path"]) {
      parseWarnings.push(
        'Ignored <vellum-attachment />: missing required "path" attribute.',
      );
      return fullMatch;
    }

    const sourceRaw = attrs["source"] ?? "sandbox";
    if (sourceRaw !== "sandbox" && sourceRaw !== "host") {
      parseWarnings.push(
        `Ignored <vellum-attachment />: invalid source="${sourceRaw}". Must be "sandbox" or "host".`,
      );
      return fullMatch;
    }

    directiveRequests.push({
      source: sourceRaw,
      path: attrs["path"],
      filename: attrs["filename"] || undefined,
      mimeType: attrs["mime_type"] || undefined,
    });

    return "";
  });

  return {
    cleanText:
      directiveRequests.length > 0
        ? cleanText.replace(/\n{3,}/g, "\n\n").trim()
        : cleanText,
    directiveRequests,
    parseWarnings,
  };
}

/**
 * Drain streamed assistant text while stripping only valid, complete
 * self-closing `<vellum-attachment ... />` directives.
 *
 * - Valid complete directives are removed from emitted text.
 * - Invalid directives are preserved as plain text.
 * - Incomplete directives are retained in `bufferedRemainder` until more
 *   text arrives.
 */
const DIRECTIVE_TAG_PREFIX = "<vellum-attachment";

/**
 * Check whether `text` ends with a prefix of `tag` (e.g. "<", "<v", "<ve", …).
 * Returns the safe-to-emit portion and any trailing partial prefix to buffer.
 */
function splitTrailingPrefix(
  text: string,
  tag: string,
): { safe: string; trailing: string } {
  // Scan backwards from the end for a '<' that could start a partial tag.
  // We only need to check the last `tag.length - 1` characters — a full
  // match would have been caught by indexOf above.
  const searchStart = Math.max(0, text.length - tag.length + 1);
  for (let i = text.length - 1; i >= searchStart; i--) {
    if (text[i] === "<") {
      const candidate = text.slice(i);
      if (tag.startsWith(candidate)) {
        return { safe: text.slice(0, i), trailing: candidate };
      }
    }
  }
  return { safe: text, trailing: "" };
}

export function drainDirectiveDisplayBuffer(
  buffer: string,
): DirectiveDisplayDrainResult {
  let emitText = "";
  let cursor = 0;

  while (cursor < buffer.length) {
    const start = buffer.indexOf(DIRECTIVE_TAG_PREFIX, cursor);
    if (start === -1) {
      // No full tag-prefix match — but the remaining text might end with a
      // partial prefix of "<vellum-attachment" split across streaming chunks.
      const remaining = buffer.slice(cursor);
      const split = splitTrailingPrefix(remaining, DIRECTIVE_TAG_PREFIX);
      emitText += split.safe;
      return { emitText, bufferedRemainder: split.trailing };
    }

    emitText += buffer.slice(cursor, start);

    const end = buffer.indexOf("/>", start);
    if (end === -1) {
      return {
        emitText,
        bufferedRemainder: buffer.slice(start),
      };
    }

    const tag = buffer.slice(start, end + 2);
    const parsed = parseDirectives(tag);
    const isValidDirective =
      parsed.directiveRequests.length > 0 &&
      parsed.parseWarnings.length === 0 &&
      parsed.cleanText.length === 0;

    if (!isValidDirective) {
      emitText += tag;
    } else {
      // Only trim the trailing newline when the directive occupied its own
      // line (preceded by \n and followed by \n or \r\n). We intentionally
      // do NOT trim when nextChar is undefined (end-of-buffer) because in
      // streaming mode more data may arrive in the next chunk — eagerly
      // trimming would merge words across the directive boundary.
      const nextChar = buffer[end + 2];
      if (emitText.endsWith("\r\n") && nextChar === "\r") {
        emitText = emitText.slice(0, -2); // trim full \r\n
      } else if (
        emitText.endsWith("\n") &&
        (nextChar === "\n" || nextChar === "\r")
      ) {
        emitText = emitText.slice(0, -1); // trim \n
      } else if (
        nextChar !== undefined &&
        !/\s/.test(emitText[emitText.length - 1] ?? "") &&
        !/\s/.test(nextChar)
      ) {
        // Inline directive with no surrounding whitespace — insert a space
        // so the text on either side doesn't get smashed together (e.g.
        // "down.Let" → "down. Let").
        emitText += " ";
      }
    }

    cursor = end + 2;
  }

  return { emitText, bufferedRemainder: "" };
}

// ---------------------------------------------------------------------------
// Sandbox file resolution
// ---------------------------------------------------------------------------

export interface ResolveResult {
  draft: AssistantAttachmentDraft | null;
  warning: string | null;
}

/**
 * Resolve a sandbox directive to a draft attachment.
 *
 * Validates the path stays within the sandbox boundary, reads the file,
 * base64-encodes it, and enforces the per-attachment size cap.
 */
export function resolveSandboxDirective(
  directive: DirectiveRequest,
  workingDir: string,
): ResolveResult {
  const pathResult = sandboxPolicy(directive.path, workingDir);
  if (!pathResult.ok) {
    return {
      draft: null,
      warning: `Skipped sandbox attachment "${directive.path}": ${pathResult.error}`,
    };
  }

  const resolved = pathResult.resolved;

  let stat;
  try {
    stat = statSync(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        draft: null,
        warning: `Skipped sandbox attachment "${directive.path}": file not found.`,
      };
    }
    return {
      draft: null,
      warning: `Skipped sandbox attachment "${directive.path}": stat error: ${
        (err as Error).message
      }`,
    };
  }

  if (!stat.isFile()) {
    return {
      draft: null,
      warning: `Skipped sandbox attachment "${directive.path}": not a regular file.`,
    };
  }

  if (stat.size > MAX_ASSISTANT_ATTACHMENT_BYTES) {
    return {
      draft: null,
      warning: `Skipped sandbox attachment "${
        directive.path
      }": size ${formatBytes(stat.size)} exceeds ${formatBytes(
        MAX_ASSISTANT_ATTACHMENT_BYTES,
      )} limit.`,
    };
  }

  let data: Buffer;
  try {
    data = readFileSync(resolved);
  } catch (err) {
    return {
      draft: null,
      warning: `Skipped sandbox attachment "${directive.path}": read error: ${
        (err as Error).message
      }`,
    };
  }

  const filename = directive.filename ?? basename(resolved);
  const mimeType = directive.mimeType ?? inferMimeType(filename);
  const dataBase64 = data.toString("base64");

  return {
    draft: {
      sourceType: "sandbox_file",
      filename,
      mimeType,
      dataBase64,
      sizeBytes: data.length,
      kind: classifyKind(mimeType),
    },
    warning: null,
  };
}

// ---------------------------------------------------------------------------
// Host file resolution
// ---------------------------------------------------------------------------

/**
 * Callback the caller provides to approve host file reads.
 * Returns `true` to allow, `false` to deny/skip.
 */
export type ApproveHostRead = (filePath: string) => Promise<boolean>;

/**
 * Resolve a host directive to a draft attachment.
 *
 * Requires an absolute path. Before reading, calls the `approve` callback
 * so the conversation layer can gate access via the user-facing permission prompt.
 */
export async function resolveHostDirective(
  directive: DirectiveRequest,
  approve: ApproveHostRead,
): Promise<ResolveResult> {
  const pathResult = hostPolicy(directive.path);
  if (!pathResult.ok) {
    return {
      draft: null,
      warning: `Skipped host attachment "${directive.path}": ${pathResult.error}`,
    };
  }

  const resolved = pathResult.resolved;

  // Gate on user approval before touching the filesystem
  let approved: boolean;
  try {
    approved = await approve(resolved);
  } catch {
    return {
      draft: null,
      warning: `Skipped host attachment "${directive.path}": approval request failed.`,
    };
  }

  if (!approved) {
    return {
      draft: null,
      warning: `Skipped host attachment "${directive.path}": access denied by user.`,
    };
  }

  let stat;
  try {
    stat = statSync(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        draft: null,
        warning: `Skipped host attachment "${directive.path}": file not found.`,
      };
    }
    return {
      draft: null,
      warning: `Skipped host attachment "${directive.path}": stat error: ${
        (err as Error).message
      }`,
    };
  }

  if (!stat.isFile()) {
    return {
      draft: null,
      warning: `Skipped host attachment "${directive.path}": not a regular file.`,
    };
  }

  if (stat.size > MAX_ASSISTANT_ATTACHMENT_BYTES) {
    return {
      draft: null,
      warning: `Skipped host attachment "${directive.path}": size ${formatBytes(
        stat.size,
      )} exceeds ${formatBytes(MAX_ASSISTANT_ATTACHMENT_BYTES)} limit.`,
    };
  }

  let data: Buffer;
  try {
    data = readFileSync(resolved);
  } catch (err) {
    return {
      draft: null,
      warning: `Skipped host attachment "${directive.path}": read error: ${
        (err as Error).message
      }`,
    };
  }

  const filename = directive.filename ?? basename(resolved);
  const mimeType = directive.mimeType ?? inferMimeType(filename);
  const dataBase64 = data.toString("base64");

  return {
    draft: {
      sourceType: "host_file",
      filename,
      mimeType,
      dataBase64,
      sizeBytes: data.length,
      kind: classifyKind(mimeType),
    },
    warning: null,
  };
}

// ---------------------------------------------------------------------------
// Batch directive resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an array of parsed directives to attachment drafts.
 *
 * Sandbox directives are resolved synchronously; host directives go through
 * the async approval callback.
 */
export async function resolveDirectives(
  directives: DirectiveRequest[],
  workingDir: string,
  approveHostRead: ApproveHostRead,
): Promise<{ drafts: AssistantAttachmentDraft[]; warnings: string[] }> {
  const drafts: AssistantAttachmentDraft[] = [];
  const warnings: string[] = [];

  for (const d of directives) {
    const result =
      d.source === "sandbox"
        ? resolveSandboxDirective(d, workingDir)
        : await resolveHostDirective(d, approveHostRead);
    if (result.draft) drafts.push(result.draft);
    if (result.warning) warnings.push(result.warning);
  }

  return { drafts, warnings };
}

// ---------------------------------------------------------------------------
// Tool content block → draft conversion
// ---------------------------------------------------------------------------

interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

interface FileBlock {
  type: "file";
  source: {
    type: "base64";
    media_type: string;
    data: string;
    filename: string;
  };
}

/**
 * Derive a human-friendly filename from the tool name that produced the
 * content block. Falls back to "tool-output" for unknown tools.
 */
function toolNameToFilePrefix(toolName?: string): string {
  if (!toolName) return "tool-output";
  // Convert snake_case / camelCase tool names to kebab-case labels
  return toolName
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

/**
 * Convert tool content blocks (images/files from tool results) into
 * attachment drafts. Blocks that aren't image or file types are skipped.
 *
 * An optional `toolNames` map (index → tool name) produces friendlier
 * filenames than the default "tool-output".
 */
export function contentBlocksToDrafts(
  blocks: readonly unknown[],
  toolNames?: ReadonlyMap<number, string>,
): AssistantAttachmentDraft[] {
  const drafts: AssistantAttachmentDraft[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i] as Record<string, unknown>;
    const toolName = toolNames?.get(i);
    if (b.type === "image") {
      const src = b.source as ImageBlock["source"];
      const data = src.data;
      const mimeType = src.media_type;
      const ext = mimeType.split("/")[1] ?? "png";
      const title = typeof b._title === "string" ? b._title : undefined;
      const prefix = title || toolNameToFilePrefix(toolName);
      drafts.push({
        sourceType: "tool_block",
        filename: `${prefix}.${ext}`,
        mimeType,
        dataBase64: data,
        sizeBytes: estimateBase64Bytes(data),
        kind: "image",
      });
    } else if (b.type === "file") {
      const src = b.source as FileBlock["source"];
      const data = src.data;
      const mimeType = src.media_type;
      const filename = src.filename;
      drafts.push({
        sourceType: "tool_block",
        filename,
        mimeType,
        dataBase64: data,
        sizeBytes: estimateBase64Bytes(data),
        kind: classifyKind(mimeType),
      });
    }
  }

  return drafts;
}

// ---------------------------------------------------------------------------
// Content cleaning: strip directives from assistant text blocks
// ---------------------------------------------------------------------------

/**
 * Parse directives from assistant content blocks, returning cleaned content
 * (tags stripped) and all accumulated directive requests + warnings.
 */
export function cleanAssistantContent(content: readonly unknown[]): {
  cleanedContent: unknown[];
  directives: DirectiveRequest[];
  warnings: string[];
} {
  const directives: DirectiveRequest[] = [];
  const warnings: string[] = [];

  const cleanedContent = content.map((block) => {
    const b = block as Record<string, unknown>;
    if (b.type !== "text") return block;
    const text = b.text as string;
    // Only run the directive parser when the text actually contains a
    // potential tag. This avoids unintentional whitespace normalisation
    // (parseDirectives trims and collapses blank lines) on plain messages.
    if (!text.includes("<vellum-attachment")) return block;
    const result = parseDirectives(text);
    directives.push(...result.directiveRequests);
    warnings.push(...result.parseWarnings);
    return { ...b, text: result.cleanText };
  });

  return { cleanedContent, directives, warnings };
}

// ---------------------------------------------------------------------------
// De-duplication
// ---------------------------------------------------------------------------

/**
 * De-duplicate drafts by filename + content hash.
 *
 * Exact duplicates (same name, same bytes) are always collapsed.
 * Additionally, tool_block drafts whose content already appeared from a
 * non-tool source (directive) are dropped — this prevents the same file
 * data from being attached twice when it appears as both a directive tag
 * (user-chosen name) and an auto-converted tool block ("tool-output.png").
 */
export function deduplicateDrafts(
  drafts: AssistantAttachmentDraft[],
): AssistantAttachmentDraft[] {
  const seenKeys = new Set<string>();
  const seenDirectiveHashes = new Set<string>();
  return drafts.filter((d) => {
    const hash = Bun.hash(d.dataBase64).toString(36);
    const key = `${d.filename}:${hash}`;

    // Exact duplicate (same filename + same content): always skip.
    if (seenKeys.has(key)) return false;

    // Tool-block draft whose content was already attached via a directive:
    // drop the tool-block copy so the directive's user-chosen name wins.
    if (d.sourceType === "tool_block" && seenDirectiveHashes.has(hash))
      return false;

    seenKeys.add(key);
    if (d.sourceType !== "tool_block") seenDirectiveHashes.add(hash);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
