// Shared types used across multiple message domains.

export type ConversationType = "standard" | "private";

/** Runtime normalizer — collapses unknown/legacy DB values to 'standard'. */
export function normalizeConversationType(
  raw: string | null | undefined,
): ConversationType {
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
  /** Origin of the attachment on the daemon side, when known. */
  sourceType?: "sandbox_file" | "host_file" | "tool_block";
  extractedText?: string;
  /** Original file size in bytes. Present when data was omitted from history_response to reduce payload size. */
  sizeBytes?: number;
  /** Base64-encoded JPEG thumbnail. Generated server-side for video attachments. */
  thumbnailData?: string;
  /** Absolute path to the local file on disk. Present for file-backed attachments (e.g. recordings). */
  filePath?: string;
  /** True when the attachment is file-backed and clients should hydrate via the /content endpoint. */
  fileBacked?: boolean;
}
