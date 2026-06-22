export function formatFileSize(
  bytes: number | null | undefined,
  fallback = "",
): string {
  if (bytes == null) return fallback;
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  // Switch to GB once a value would render as 0.1 GB or larger (100 MiB).
  if (bytes >= 100 * 1024 * 1024)
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
