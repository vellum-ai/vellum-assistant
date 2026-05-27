/**
 * In-memory HTML cache for app preview thumbnails and the viewer.
 *
 * The daemon's `apps/:id/open` is idempotent for already-built apps
 * (returns the disk-cached HTML) and auto-compiles once for multi-file
 * apps that have not been built yet. Caching here means a Library scroll
 * triggers at most one fetch per app, and opening the viewer afterwards
 * is free.
 */

import { appsByIdOpenPost } from "@/generated/daemon/sdk.gen";

const htmlCache = new Map<string, Promise<string>>();

function cacheKey(assistantId: string, appId: string): string {
  return `${assistantId}::${appId}`;
}

export function getCachedAppHtml(
  assistantId: string,
  appId: string,
): Promise<string> {
  const key = cacheKey(assistantId, appId);
  let entry = htmlCache.get(key);
  if (entry == null) {
    entry = appsByIdOpenPost({
      path: { assistant_id: assistantId, id: appId },
      throwOnError: true,
    })
      .then((r) => r.data.html)
      .catch((err) => {
        htmlCache.delete(key);
        throw err;
      });
    htmlCache.set(key, entry);
  }
  return entry;
}

export function primeAppHtmlCache(
  assistantId: string,
  appId: string,
  html: string,
): void {
  htmlCache.set(cacheKey(assistantId, appId), Promise.resolve(html));
}

export function clearAppHtmlCache(assistantId: string, appId: string): void {
  htmlCache.delete(cacheKey(assistantId, appId));
}
