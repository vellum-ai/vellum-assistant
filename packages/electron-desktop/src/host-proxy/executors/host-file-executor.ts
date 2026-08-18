/**
 * Host file executor — handles read/write/edit operations on the local
 * filesystem via the host proxy bridge.
 *
 * Desktop client adapters inject it into the shared host-proxy router.
 * Results are posted back to the daemon through HostProxyPoster.postFileResult.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Stats } from "node:fs";

import type { HostProxyExecutor } from "../router";
import type { HostProxyPoster } from "../poster";
import type { HostProxySseMessage } from "../sse";
import log from "./logger";

// ---------------------------------------------------------------------------
// Host filesystem safety checks
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const DENIED_BASENAMES = new Set([".backup.key", "backup.key"]);

/**
 * Characters returned by a read that names no `maxChars`. The daemon resolves
 * this same default before proxying, so this covers a client driven by an
 * older daemon that sends none. Mirrors `READ_CHAR_BUDGET` in the assistant's
 * `tools/shared/filesystem/file-ops-service.ts`, which owns the value and the
 * wording of the notice below.
 */
const READ_CHAR_BUDGET = 20_000;

const isHighSurrogate = (code: number): boolean =>
  code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean =>
  code >= 0xdc00 && code <= 0xdfff;

/**
 * Character window that never splits a surrogate pair. A split leaves a lone
 * half at each edge, and each encodes to U+FFFD, so the character is lost from
 * both this window and the next one paged in after it.
 */
function surrogateSafeWindow(
  total: number,
  charCodeAt: (index: number) => number,
  requestedStart: number,
  maxChars: number,
): { start: number; end: number } {
  let start = Math.max(0, Math.min(requestedStart, total));
  if (start > 0 && start < total && isLowSurrogate(charCodeAt(start))) {
    start -= 1;
  }

  let end = Math.min(total, start + maxChars);
  if (end > start && end < total && isHighSurrogate(charCodeAt(end - 1))) {
    // Backing off would empty a one-character window, which stalls paging on
    // the same offset, so take the whole pair instead.
    end = end - 1 > start ? end - 1 : Math.min(total, end + 1);
  }

  return { start, end };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validateHostPath(
  rawPath: string,
): { ok: true; path: string } | { ok: false; content: string; isError: true } {
  if (!path.isAbsolute(rawPath)) {
    return {
      content: `path must be absolute for host file access: ${rawPath}`,
      isError: true,
      ok: false,
    };
  }

  const basename = path.basename(rawPath);
  if (DENIED_BASENAMES.has(basename)) {
    return {
      content: `Access to "${basename}" is denied`,
      isError: true,
      ok: false,
    };
  }

  return { ok: true, path: rawPath };
}

function validateRegularFile(
  filePath: string,
): { ok: true; stat: Stats } | { ok: false; content: string; isError: true } {
  const resolved = fs.realpathSync(filePath);
  const resolvedBasename = path.basename(resolved);
  if (DENIED_BASENAMES.has(resolvedBasename)) {
    return {
      content: `Access to "${resolvedBasename}" is denied`,
      isError: true,
      ok: false,
    };
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return {
      content: `Not a regular file: ${filePath}`,
      isError: true,
      ok: false,
    };
  }
  return { ok: true, stat };
}

function validateFileSize(
  filePath: string,
  size: number,
): { ok: true } | { ok: false; content: string; isError: true } {
  if (size > MAX_FILE_SIZE_BYTES) {
    return {
      content: `File size (${formatBytes(size)}) exceeds the ${formatBytes(MAX_FILE_SIZE_BYTES)} limit: ${filePath}`,
      isError: true,
      ok: false,
    };
  }
  return { ok: true };
}

function validateContentSize(
  content: string,
  filePath: string,
): { ok: true } | { ok: false; content: string; isError: true } {
  const size = Buffer.byteLength(content, "utf-8");
  if (size > MAX_FILE_SIZE_BYTES) {
    return {
      content: `Content size (${formatBytes(size)}) exceeds the ${formatBytes(MAX_FILE_SIZE_BYTES)} limit for: ${filePath}`,
      isError: true,
      ok: false,
    };
  }
  return { ok: true };
}

function resolveSymlinkChain(startPath: string): string {
  let current = startPath;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    let st: Stats;
    try {
      st = fs.lstatSync(current);
    } catch {
      return current;
    }
    if (!st.isSymbolicLink()) return current;
    const target = fs.readlinkSync(current);
    current = path.isAbsolute(target)
      ? target
      : path.resolve(path.dirname(current), target);
  }
}

function validateWriteTarget(
  filePath: string,
): { ok: true } | { ok: false; content: string; isError: true } {
  let lstat: Stats;
  try {
    lstat = fs.lstatSync(filePath);
  } catch {
    return { ok: true };
  }

  if (lstat.isSymbolicLink()) {
    const resolved = resolveSymlinkChain(filePath);
    if (DENIED_BASENAMES.has(path.basename(resolved))) {
      return {
        content: `Access to "${path.basename(resolved)}" is denied`,
        isError: true,
        ok: false,
      };
    }
    try {
      const targetStat = fs.statSync(filePath);
      if (!targetStat.isFile()) {
        return {
          content: `Not a regular file: ${filePath}`,
          isError: true,
          ok: false,
        };
      }
    } catch {
      // Dangling symlink with allowed target basename — write will create regular file
    }
  } else if (!lstat.isFile()) {
    return {
      content: `Not a regular file: ${filePath}`,
      isError: true,
      ok: false,
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Magic-byte detection helpers
// ---------------------------------------------------------------------------

/** Check leading bytes against known image signatures. */
function isImageByMagicBytes(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return true;
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true;
  // WebP: RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  )
    return true;
  return false;
}

interface AudioDetection {
  mimeType: string;
}

/** Check leading bytes against known audio signatures. Returns mime type or null. */
function detectAudioByMagicBytes(buf: Buffer): AudioDetection | null {
  if (buf.length < 4) return null;
  // MP3 — ID3 tag
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33)
    return { mimeType: "audio/mpeg" };
  // MP3 — sync word 0xFF 0xFB (or 0xFF 0xEx)
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
    return { mimeType: "audio/mpeg" };
  // OGG
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53)
    return { mimeType: "audio/ogg" };
  // FLAC
  if (buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43)
    return { mimeType: "audio/flac" };
  // WAV: RIFF....WAVE
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x41 &&
    buf[10] === 0x56 &&
    buf[11] === 0x45
  )
    return { mimeType: "audio/wav" };
  // M4A: bytes 4-7 contain "ftyp"
  if (
    buf.length >= 8 &&
    buf[4] === 0x66 &&
    buf[5] === 0x74 &&
    buf[6] === 0x79 &&
    buf[7] === 0x70
  )
    return { mimeType: "audio/mp4" };
  return null;
}

// ---------------------------------------------------------------------------
// Read operation
// ---------------------------------------------------------------------------

interface ReadFields {
  path: string;
  startIndex?: number;
  maxChars?: number;
  /** Line-based window sent by a daemon older than the character window. */
  offset?: number;
  /** Line-based window sent by a daemon older than the character window. */
  limit?: number;
}

const LEGACY_READ_LINE_LIMIT = 2000;

/**
 * Line window for a daemon that predates the character window. This app
 * auto-updates on its own cadence, so a newer client can be driven by an older
 * daemon. Reading its `offset` as a character index would silently return the
 * wrong region, and ignoring it would pin every page to the start of the file,
 * so the old semantics are honored as they were. Delete once no daemon in the
 * field sends these fields.
 */
function executeLegacyLineRead(
  text: string,
  offset: number | undefined,
  limit: number | undefined,
): { content: string } {
  const lines = text.split("\n");
  const start = Math.max(0, (offset ?? 1) - 1);
  const sliced = lines.slice(start, start + (limit ?? LEGACY_READ_LINE_LIMIT));
  const lastLineReturned = start + sliced.length;
  const content = sliced.join("\n");
  if (sliced.length > 0 && lastLineReturned < lines.length) {
    return {
      content: `${content}\n\n[Truncated: showing through line ${lastLineReturned} of ${lines.length}. Read on with offset=${lastLineReturned + 1}, or pass an explicit limit.]`,
    };
  }
  return { content };
}

function executeRead(fields: ReadFields): {
  content?: string;
  imageData?: string;
  audioData?: string;
  audioMimeType?: string;
  isError?: boolean;
} {
  const pathCheck = validateHostPath(fields.path);
  if (!pathCheck.ok) return pathCheck;

  const filePath = pathCheck.path;
  const fileCheck = validateRegularFile(filePath);
  if (!fileCheck.ok) return fileCheck;

  const sizeCheck = validateFileSize(filePath, fileCheck.stat.size);
  if (!sizeCheck.ok) return sizeCheck;

  const raw = fs.readFileSync(filePath);

  // Check for image
  if (isImageByMagicBytes(raw)) {
    return { imageData: raw.toString("base64") };
  }

  // Check for audio
  const audio = detectAudioByMagicBytes(raw);
  if (audio) {
    return { audioData: raw.toString("base64"), audioMimeType: audio.mimeType };
  }

  // Text file: apply the character window
  const text = raw.toString("utf-8");

  if (fields.startIndex === undefined && fields.maxChars === undefined) {
    if (fields.offset !== undefined || fields.limit !== undefined) {
      return executeLegacyLineRead(text, fields.offset, fields.limit);
    }
  }

  const maxChars = Math.min(
    READ_CHAR_BUDGET,
    Math.max(0, fields.maxChars ?? READ_CHAR_BUDGET),
  );
  const { start, end } = surrogateSafeWindow(
    text.length,
    (i) => text.charCodeAt(i),
    fields.startIndex ?? 0,
    maxChars,
  );
  const content = text.slice(start, end);
  if (content.length > 0 && end < text.length) {
    return {
      content: `${content}\n\n[Truncated: characters ${start}-${end} of ${text.length}. Read on with start_index=${end}.]`,
    };
  }
  return { content };
}

// ---------------------------------------------------------------------------
// Write operation
// ---------------------------------------------------------------------------

interface WriteFields {
  path: string;
  content: string;
}

function executeWrite(fields: WriteFields): {
  content?: string;
  isError?: boolean;
} {
  const pathCheck = validateHostPath(fields.path);
  if (!pathCheck.ok) return pathCheck;

  const filePath = pathCheck.path;
  const sizeCheck = validateContentSize(fields.content, filePath);
  if (!sizeCheck.ok) return sizeCheck;

  const targetCheck = validateWriteTarget(filePath);
  if (!targetCheck.ok) return targetCheck;

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, fields.content, "utf-8");
  return {
    content: `Wrote ${Buffer.byteLength(fields.content, "utf-8")} bytes to ${filePath}`,
  };
}

// ---------------------------------------------------------------------------
// Edit operation
// ---------------------------------------------------------------------------

interface EditFields {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function executeEdit(fields: EditFields): {
  content?: string;
  isError?: boolean;
} {
  const pathCheck = validateHostPath(fields.path);
  if (!pathCheck.ok) return pathCheck;

  const filePath = pathCheck.path;
  const fileCheck = validateRegularFile(filePath);
  if (!fileCheck.ok) return fileCheck;

  const sizeCheck = validateFileSize(filePath, fileCheck.stat.size);
  if (!sizeCheck.ok) return sizeCheck;

  const existing = fs.readFileSync(filePath, "utf-8");
  const { old_string, new_string, replace_all } = fields;

  const firstIdx = existing.indexOf(old_string);
  if (firstIdx === -1) {
    return { content: `old_string not found in ${filePath}`, isError: true };
  }

  let updated: string;
  if (!replace_all) {
    const secondIdx = existing.indexOf(old_string, firstIdx + 1);
    if (secondIdx !== -1) {
      return {
        content: `old_string is not unique in ${filePath} (use replace_all to replace all occurrences)`,
        isError: true,
      };
    }
    updated =
      existing.slice(0, firstIdx) +
      new_string +
      existing.slice(firstIdx + old_string.length);
  } else {
    updated = existing.split(old_string).join(new_string);
  }

  const outputSizeCheck = validateContentSize(updated, filePath);
  if (!outputSizeCheck.ok) return outputSizeCheck;

  fs.writeFileSync(filePath, updated, "utf-8");

  return { content: `Edited ${filePath}` };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

const pendingRequests = new Set<string>();

function handleRequest(
  message: HostProxySseMessage,
  poster: HostProxyPoster,
): void {
  const requestId = message.requestId as string | undefined;
  if (!requestId) {
    log.warn("[host-file-executor] message missing requestId");
    return;
  }

  const operation = message.operation as string | undefined;
  const filePath = message.path as string | undefined;

  if (!operation || !filePath) {
    void poster.postFileResult({
      requestId,
      content: "Missing operation or path",
      isError: true,
    });
    return;
  }

  pendingRequests.add(requestId);

  try {
    let result: {
      content?: string;
      imageData?: string;
      audioData?: string;
      audioMimeType?: string;
      isError?: boolean;
    };

    switch (operation) {
      case "read":
        result = executeRead({
          path: filePath,
          startIndex: message.startIndex as number | undefined,
          maxChars: message.maxChars as number | undefined,
          offset: message.offset as number | undefined,
          limit: message.limit as number | undefined,
        });
        break;
      case "write":
        result = executeWrite({
          path: filePath,
          content: (message.content as string) ?? "",
        });
        break;
      case "edit":
        result = executeEdit({
          path: filePath,
          old_string: (message.old_string as string) ?? "",
          new_string: (message.new_string as string) ?? "",
          replace_all: message.replace_all as boolean | undefined,
        });
        break;
      default:
        result = { content: `Unknown operation: ${operation}`, isError: true };
    }

    if (!pendingRequests.has(requestId)) return;

    void poster.postFileResult({ requestId, ...result });
  } catch (err: unknown) {
    if (!pendingRequests.has(requestId)) return;
    const errMsg = err instanceof Error ? err.message : String(err);
    void poster.postFileResult({ requestId, content: errMsg, isError: true });
  } finally {
    pendingRequests.delete(requestId);
  }
}

function handleCancel(message: HostProxySseMessage): void {
  const requestId = message.requestId as string | undefined;
  if (requestId) {
    pendingRequests.delete(requestId);
  }
}

export const hostFileExecutor: HostProxyExecutor = {
  handleRequest,
  handleCancel,
};

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

export const __testing = {
  isImageByMagicBytes,
  detectAudioByMagicBytes,
  executeRead,
  executeWrite,
  executeEdit,
  validateHostPath,
  validateRegularFile,
  validateFileSize,
  validateContentSize,
  validateWriteTarget,
  get pendingRequests() {
    return pendingRequests;
  },
};
