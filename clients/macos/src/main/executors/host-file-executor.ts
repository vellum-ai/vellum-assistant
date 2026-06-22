/**
 * Host file executor — handles read/write/edit operations on the local
 * filesystem via the host proxy bridge.
 *
 * Plugs into the host-proxy-router via setExecutor("host_file", ...).
 * Results are posted back to the daemon through HostProxyPoster.postFileResult.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Stats } from "node:fs";

import type { HostProxyExecutor } from "../host-proxy-router";
import type { HostProxyPoster } from "../host-proxy-poster";
import type { HostProxySseMessage } from "../host-proxy-sse";
import log from "../logger";

// ---------------------------------------------------------------------------
// Host filesystem safety checks
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const DENIED_BASENAMES = new Set([".backup.key", "backup.key"]);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validateHostPath(rawPath: string): { ok: true; path: string } | { ok: false; content: string; isError: true } {
  if (!path.isAbsolute(rawPath)) {
    return { content: `path must be absolute for host file access: ${rawPath}`, isError: true, ok: false };
  }

  const basename = path.basename(rawPath);
  if (DENIED_BASENAMES.has(basename)) {
    return { content: `Access to "${basename}" is denied`, isError: true, ok: false };
  }

  return { ok: true, path: rawPath };
}

function validateRegularFile(filePath: string): { ok: true; stat: Stats } | { ok: false; content: string; isError: true } {
  const resolved = fs.realpathSync(filePath);
  const resolvedBasename = path.basename(resolved);
  if (DENIED_BASENAMES.has(resolvedBasename)) {
    return { content: `Access to "${resolvedBasename}" is denied`, isError: true, ok: false };
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return { content: `Not a regular file: ${filePath}`, isError: true, ok: false };
  }
  return { ok: true, stat };
}

function validateFileSize(filePath: string, size: number): { ok: true } | { ok: false; content: string; isError: true } {
  if (size > MAX_FILE_SIZE_BYTES) {
    return {
      content: `File size (${formatBytes(size)}) exceeds the ${formatBytes(MAX_FILE_SIZE_BYTES)} limit: ${filePath}`,
      isError: true,
      ok: false,
    };
  }
  return { ok: true };
}

function validateContentSize(content: string, filePath: string): { ok: true } | { ok: false; content: string; isError: true } {
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
    current = path.isAbsolute(target) ? target : path.resolve(path.dirname(current), target);
  }
}

function validateWriteTarget(filePath: string): { ok: true } | { ok: false; content: string; isError: true } {
  let lstat: Stats;
  try {
    lstat = fs.lstatSync(filePath);
  } catch {
    return { ok: true };
  }

  if (lstat.isSymbolicLink()) {
    const resolved = resolveSymlinkChain(filePath);
    if (DENIED_BASENAMES.has(path.basename(resolved))) {
      return { content: `Access to "${path.basename(resolved)}" is denied`, isError: true, ok: false };
    }
    try {
      const targetStat = fs.statSync(filePath);
      if (!targetStat.isFile()) {
        return { content: `Not a regular file: ${filePath}`, isError: true, ok: false };
      }
    } catch {
      // Dangling symlink with allowed target basename — write will create regular file
    }
  } else if (!lstat.isFile()) {
    return { content: `Not a regular file: ${filePath}`, isError: true, ok: false };
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
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true;
  // WebP: RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return true;
  return false;
}

interface AudioDetection {
  mimeType: string;
}

/** Check leading bytes against known audio signatures. Returns mime type or null. */
function detectAudioByMagicBytes(buf: Buffer): AudioDetection | null {
  if (buf.length < 4) return null;
  // MP3 — ID3 tag
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return { mimeType: "audio/mpeg" };
  // MP3 — sync word 0xFF 0xFB (or 0xFF 0xEx)
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return { mimeType: "audio/mpeg" };
  // OGG
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return { mimeType: "audio/ogg" };
  // FLAC
  if (buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) return { mimeType: "audio/flac" };
  // WAV: RIFF....WAVE
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45
  ) return { mimeType: "audio/wav" };
  // M4A: bytes 4-7 contain "ftyp"
  if (
    buf.length >= 8 &&
    buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70
  ) return { mimeType: "audio/mp4" };
  return null;
}

// ---------------------------------------------------------------------------
// Read operation
// ---------------------------------------------------------------------------

interface ReadFields {
  path: string;
  offset?: number;
  limit?: number;
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

  // Text file — apply line-based offset/limit
  const text = raw.toString("utf-8");
  const lines = text.split("\n");
  const offset = (fields.offset ?? 1) - 1;
  const limit = fields.limit ?? lines.length;
  const sliced = lines.slice(offset, offset + limit);
  return { content: sliced.join("\n") };
}

// ---------------------------------------------------------------------------
// Write operation
// ---------------------------------------------------------------------------

interface WriteFields {
  path: string;
  content: string;
}

function executeWrite(fields: WriteFields): { content?: string; isError?: boolean } {
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
  return { content: `Wrote ${Buffer.byteLength(fields.content, "utf-8")} bytes to ${filePath}` };
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

function executeEdit(fields: EditFields): { content?: string; isError?: boolean } {
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
      return { content: `old_string is not unique in ${filePath} (use replace_all to replace all occurrences)`, isError: true };
    }
    updated = existing.slice(0, firstIdx) + new_string + existing.slice(firstIdx + old_string.length);
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

function handleRequest(message: HostProxySseMessage, poster: HostProxyPoster): void {
  const requestId = message.requestId as string | undefined;
  if (!requestId) {
    log.warn("[host-file-executor] message missing requestId");
    return;
  }

  const operation = message.operation as string | undefined;
  const filePath = message.path as string | undefined;

  if (!operation || !filePath) {
    void poster.postFileResult({ requestId, content: "Missing operation or path", isError: true });
    return;
  }

  pendingRequests.add(requestId);

  try {
    let result: { content?: string; imageData?: string; audioData?: string; audioMimeType?: string; isError?: boolean };

    switch (operation) {
      case "read":
        result = executeRead({
          path: filePath,
          offset: message.offset as number | undefined,
          limit: message.limit as number | undefined,
        });
        break;
      case "write":
        result = executeWrite({
          path: filePath,
          content: message.content as string ?? "",
        });
        break;
      case "edit":
        result = executeEdit({
          path: filePath,
          old_string: message.old_string as string ?? "",
          new_string: message.new_string as string ?? "",
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
