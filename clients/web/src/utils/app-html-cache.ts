/**
 * In-memory HTML cache for app preview thumbnails and the viewer.
 *
 * The daemon's `apps/:id/open` is idempotent for already-built apps
 * (returns the disk-cached HTML) and auto-compiles once for multi-file
 * apps that have not been built yet. Caching here means a Library scroll
 * triggers at most one fetch per app revision, and opening the viewer
 * afterwards is free.
 */

import { appsByIdOpenPost } from "@/generated/daemon/sdk.gen";

interface AppHtmlEntry {
  updatedAt?: number;
  html: Promise<string>;
}

const htmlCache = new Map<string, AppHtmlEntry>();

function requireAppHtml(html: unknown): string {
  if (typeof html !== "string" || html.trim().length === 0) {
    throw new Error("App response did not contain HTML");
  }
  return html;
}

function cacheKey(assistantId: string, appId: string): string {
  return `${assistantId}::${appId}`;
}

export function getCachedAppHtml(
  assistantId: string,
  appId: string,
  updatedAt?: number,
): Promise<string> {
  const key = cacheKey(assistantId, appId);
  let entry = htmlCache.get(key);
  if (entry == null || (updatedAt != null && entry.updatedAt !== updatedAt)) {
    const html = appsByIdOpenPost({
      path: { assistant_id: assistantId, id: appId },
      throwOnError: true,
    })
      .then((r) => requireAppHtml(r.data.html))
      .catch((err) => {
        if (htmlCache.get(key)?.html === html) {
          htmlCache.delete(key);
        }
        throw err;
      });
    entry = { updatedAt, html };
    htmlCache.set(key, entry);
  }
  return entry.html;
}

export function primeAppHtmlCache(
  assistantId: string,
  appId: string,
  html: string,
  updatedAt?: number,
): void {
  const key = cacheKey(assistantId, appId);
  htmlCache.set(key, {
    updatedAt,
    html: Promise.resolve(requireAppHtml(html)),
  });
}

export function clearAppHtmlCache(assistantId: string, appId: string): void {
  htmlCache.delete(cacheKey(assistantId, appId));
}
