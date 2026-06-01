import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

import { GEMINI_MAX_INLINE_AUDIO_BYTES } from "../../../providers/gemini/inline-media.js";
import type { FileContent } from "../../../providers/types.js";
import type { ToolExecutionResult } from "../../types.js";

/**
 * Extension → MIME map for audio files the agent can read. Kept identical to
 * the canonical upload mapping (`migrations/191-backfill-audio-attachment-mime-types`)
 * so a `.mp3` read produces `audio/mpeg` — the same input the attachment path
 * feeds `normalizeGeminiAudioMime` (which maps it to Gemini's `audio/mp3`).
 */
const EXTENSION_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".m4a": "audio/x-m4a",
  ".opus": "audio/opus",
};

export const AUDIO_EXTENSIONS = new Set(Object.keys(EXTENSION_MIME));

// Audio is sent to Gemini inline; its inline-request ceiling is the binding
// limit and the only consumer that uses the bytes. Cap the read there rather
// than embedding a payload that would just be dropped.
const MAX_AUDIO_BYTES = GEMINI_MAX_INLINE_AUDIO_BYTES;
const MAX_AUDIO_MB = Math.round(MAX_AUDIO_BYTES / (1024 * 1024));

function buildAudioToolResult(
  buffer: Buffer,
  sourceLabel: string,
  mimeType: string,
): ToolExecutionResult {
  if (buffer.length > MAX_AUDIO_BYTES) {
    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
    return {
      content: `Error: audio too large (${sizeMB} MB). Maximum is ${MAX_AUDIO_MB} MB (the inline-audio limit). Ask for a shorter clip.`,
      isError: true,
    };
  }

  const fileBlock: FileContent = {
    type: "file",
    source: {
      type: "base64",
      media_type: mimeType,
      data: buffer.toString("base64"),
      filename: basename(sourceLabel),
    },
  };

  return {
    content: `Audio loaded: ${sourceLabel} (${buffer.length} bytes, ${mimeType})`,
    isError: false,
    contentBlocks: [fileBlock],
  };
}

/**
 * Read an audio file from disk and return a ToolExecutionResult carrying a
 * base64 `file` content block so an audio-capable model (Gemini) can hear it.
 * No transcoding — audio can't be cheaply optimized like images.
 *
 * The caller is responsible for path resolution and sandbox enforcement —
 * `resolvedPath` must be an already-validated absolute path.
 */
export function readAudioFile(resolvedPath: string): ToolExecutionResult {
  const mimeType = EXTENSION_MIME[extname(resolvedPath).toLowerCase()];
  if (!mimeType) {
    // Defensive: callers gate on AUDIO_EXTENSIONS, so this is unreachable.
    return {
      content: `Error: unsupported audio file: ${resolvedPath}`,
      isError: true,
    };
  }

  let stat;
  try {
    stat = statSync(resolvedPath);
  } catch {
    return { content: `Error: file not found: ${resolvedPath}`, isError: true };
  }
  if (!stat.isFile()) {
    return { content: `Error: ${resolvedPath} is not a file`, isError: true };
  }
  if (stat.size > MAX_AUDIO_BYTES) {
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
    return {
      content: `Error: audio too large (${sizeMB} MB). Maximum is ${MAX_AUDIO_MB} MB (the inline-audio limit). Ask for a shorter clip.`,
      isError: true,
    };
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(resolvedPath) as Buffer;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error reading file: ${msg}`, isError: true };
  }

  return buildAudioToolResult(buffer, resolvedPath, mimeType);
}

/**
 * Build an audio ToolExecutionResult from already-read base64 bytes. Used by
 * the host-file proxy when a remote client streams audio back over the wire.
 */
export function readAudioBase64(
  base64Data: string,
  sourceLabel: string,
  mimeType: string,
): ToolExecutionResult {
  return buildAudioToolResult(
    Buffer.from(base64Data, "base64"),
    sourceLabel,
    mimeType,
  );
}
