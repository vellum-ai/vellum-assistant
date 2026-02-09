import { statSync } from 'node:fs';

/** Default maximum file size: 100 MB */
export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Check whether a file on disk exceeds the size limit.
 * Returns an error string if the file is too large, or undefined if OK.
 */
export function checkFileSizeOnDisk(
  filePath: string,
  limit: number = MAX_FILE_SIZE_BYTES,
): string | undefined {
  const stat = statSync(filePath);
  if (stat.size > limit) {
    return `File size (${formatBytes(stat.size)}) exceeds the ${formatBytes(limit)} limit: ${filePath}`;
  }
  return undefined;
}

/**
 * Check whether content to be written exceeds the size limit.
 * Returns an error string if the content is too large, or undefined if OK.
 */
export function checkContentSize(
  content: string,
  filePath: string,
  limit: number = MAX_FILE_SIZE_BYTES,
): string | undefined {
  const size = Buffer.byteLength(content, 'utf-8');
  if (size > limit) {
    return `Content size (${formatBytes(size)}) exceeds the ${formatBytes(limit)} limit for: ${filePath}`;
  }
  return undefined;
}
