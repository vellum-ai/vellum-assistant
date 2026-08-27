/**
 * Records the object URL currently rendered for `key`, revoking the one it
 * replaces. Each caller owns its own map so unrelated caches never revoke
 * each other's URLs.
 */
export function trackBlobUrl(
  urls: Map<string, string>,
  key: string,
  imageUrl: string | null,
): void {
  const prev = urls.get(key);
  if (prev && prev !== imageUrl) {
    URL.revokeObjectURL(prev);
  }
  if (imageUrl) {
    urls.set(key, imageUrl);
  } else {
    urls.delete(key);
  }
}
