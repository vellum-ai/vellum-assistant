export function formatFileSize(
  bytes: number | null | undefined,
  fallback = "",
): string {
  if (bytes == null) return fallback;
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
