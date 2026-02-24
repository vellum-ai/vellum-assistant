// Shared types used across multiple IPC domains.

export type ThreadType = 'standard' | 'private';

/** Runtime normalizer — collapses unknown/legacy DB values to 'standard'. */
export function normalizeThreadType(raw: string | null | undefined): ThreadType {
  return raw === 'private' ? 'private' : 'standard';
}

export interface IpcBlobRef {
  id: string;
  kind: 'ax_tree' | 'screenshot_jpeg';
  encoding: 'utf8' | 'binary';
  byteLength: number;
  sha256?: string;
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
}
