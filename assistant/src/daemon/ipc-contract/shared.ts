// Shared types used across multiple IPC domains.

export type ThreadType = "standard" | "private";

/** Runtime normalizer — collapses unknown/legacy DB values to 'standard'. */
export function normalizeThreadType(
  raw: string | null | undefined,
): ThreadType {
  return raw === "private" ? "private" : "standard";
}

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

export interface DictationContext {
  bundleIdentifier: string;
  appName: string;
  windowTitle: string;
  selectedText?: string;
  cursorInTextField: boolean;
}

/** Structured command intent — bypasses text parsing when present. */
export interface CommandIntent {
  domain: "screen_recording";
  action: "start" | "stop" | "restart" | "pause" | "resume";
}

export interface UserMessageAttachment {
  id?: string;
  filename: string;
  mimeType: string;
  data: string;
  extractedText?: string;
  /** Original file size in bytes. Present when data was omitted from history_response to reduce payload size. */
  sizeBytes?: number;
  /** Base64-encoded JPEG thumbnail. Generated server-side for video attachments. */
  thumbnailData?: string;
  /** Absolute path to the local file on disk. Present for file-backed attachments (e.g. recordings). */
  filePath?: string;
}
