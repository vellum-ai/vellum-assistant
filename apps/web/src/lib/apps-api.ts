/**
 * App CRUD and bundle operations via the generated daemon SDK.
 *
 * Types are re-exported from the generated SDK so consumers don't need
 * to reach into `@/generated/daemon/` directly.
 */

import { client as daemonClient } from "@/generated/daemon/client.gen";
import {
  appsByIdDeletePost,
  appsByIdOpenPost,
  appsByIdSharecloudPost,
  appsGet,
  appsSharedByTokenGet,
} from "@/generated/daemon/sdk.gen";
import type {
  AppsByIdOpenPostResponse,
  AppsGetResponse,
  AppsImportbundlePostResponse,
  AppsImportbundlePostResponses,
} from "@/generated/daemon/types.gen";
import { ApiError, assertHasResponse, extractErrorMessage } from "@/lib/api-errors";
import { saveFile } from "@/runtime/native-file";

// ---------------------------------------------------------------------------
// Types — re-exported from generated daemon SDK
// ---------------------------------------------------------------------------

export type AppSummary = AppsGetResponse["apps"][number];

export type AppOpenResponse = AppsByIdOpenPostResponse;

export type ImportBundleResponse = AppsImportbundlePostResponse;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function listApps(
  assistantId: string,
  conversationId?: string,
): Promise<AppSummary[]> {
  const { data, error, response } = await appsGet({
    path: { assistant_id: assistantId },
    query: conversationId ? { conversationId } : undefined,
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to list apps.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to list apps.");
    throw new ApiError(response.status, msg);
  }
  return data?.apps ?? [];
}

export async function deleteApp(
  assistantId: string,
  appId: string,
): Promise<void> {
  const { error, response } = await appsByIdDeletePost({
    path: { assistant_id: assistantId, id: appId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to delete app.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to delete app.");
    throw new ApiError(response.status, msg);
  }
  clearAppHtmlCache(assistantId, appId);
}

/**
 * Share an app as a downloadable `.vellum` bundle.
 *
 * 1. Calls the share-cloud endpoint to package the app server-side.
 * 2. Downloads the binary bundle using the returned share token.
 * 3. Saves/shares the file via the cross-platform saveFile helper.
 */
export async function shareApp(
  assistantId: string,
  appId: string,
  appName: string,
): Promise<void> {
  const { data, error, response } = await appsByIdSharecloudPost({
    path: { assistant_id: assistantId, id: appId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to share app.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to share app.");
    throw new ApiError(response.status, msg);
  }
  if (!data?.shareToken) {
    throw new ApiError(500, "Share response missing token.");
  }

  const { response: dlResponse } = await appsSharedByTokenGet({
    path: { assistant_id: assistantId, token: data.shareToken },
    throwOnError: false,
    parseAs: "stream",
  });
  if (!dlResponse || !dlResponse.ok) {
    throw new ApiError(dlResponse?.status ?? 500, "Failed to download app bundle.");
  }
  const blob = await dlResponse.blob();

  const safeName = appName.replace(/[/\\:*?"<>|]/g, "_").trim() || "App";
  await saveFile(blob, `${safeName}.vellum`);
}

/**
 * Import a `.vellum` bundle file into the assistant daemon.
 *
 * Sends the raw file bytes as `application/octet-stream`. We use
 * octet-stream (not multipart) because the Django wildcard proxy only
 * forwards `application/octet-stream` as raw binary — multipart is
 * parsed by DRF which drops the file from the forwarded body.
 */
export async function importBundle(
  assistantId: string,
  file: File,
): Promise<ImportBundleResponse> {
  const bytes = await file.arrayBuffer();
  // The daemon route definition doesn't declare a requestBody, so the
  // generated SDK types have `body?: never`. Use the raw daemon client
  // for this binary upload.
  const { data, error, response } = await daemonClient.post<
    AppsImportbundlePostResponses,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/apps/import-bundle",
    path: { assistant_id: assistantId },
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
    bodySerializer: (body) => body as ArrayBuffer,
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to import app.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to import app.");
    throw new ApiError(response.status, msg);
  }
  return data!;
}

export async function openApp(
  assistantId: string,
  appId: string,
): Promise<AppOpenResponse> {
  const { data, error, response } = await appsByIdOpenPost({
    path: { assistant_id: assistantId, id: appId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to open app.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to open app.");
    throw new ApiError(response.status, msg);
  }
  return data!;
}

// ---------------------------------------------------------------------------
// In-memory HTML cache for preview thumbnails + viewer.
//
// The daemon's `apps/:id/open` is idempotent for already-built apps (returns
// the disk-cached HTML) and auto-compiles once for multi-file apps that have
// not been built yet. Caching the result here means a Library scroll triggers
// at most one fetch per app, and opening the viewer afterwards is free.
// ---------------------------------------------------------------------------

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
    entry = openApp(assistantId, appId)
      .then((r) => r.html)
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
