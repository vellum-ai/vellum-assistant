import { client } from "@/generated/api/client.gen.js";


import { ApiError, assertHasResponse, extractErrorMessage } from "@/lib/api-errors.js";
import { saveFile } from "@/lib/native-file.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppSummary {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  createdAt: number;
  version: string;
  contentId: string;
}

interface ListAppsResponse {
  apps: AppSummary[];
}

interface AppOpenResponse {
  appId: string;
  dirName: string;
  name: string;
  html: string;
}

interface ShareAppCloudResponse {
  success: boolean;
  shareToken: string;
  shareUrl: string;
}

interface ImportBundleResponse {
  success: boolean;
  appId: string;
  name: string;
  scanResult: {
    passed: boolean;
    blocked: string[];
    warnings: string[];
  };
  signatureResult: {
    trustTier: string;
    signerKeyId?: string;
    signerDisplayName?: string;
    signerAccount?: string;
  };
}

// ---------------------------------------------------------------------------
// SDK base options — same pattern as chat/api.ts
// ---------------------------------------------------------------------------

const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Fetch the full list of apps from the assistant daemon.
 *
 * Hits `GET /v1/apps` which goes through the wildcard proxy
 * (RuntimeProxyWildcardView) → vembda → container.
 */
export async function listApps(
  assistantId: string,
  conversationId?: string,
): Promise<AppSummary[]> {
  const query: Record<string, string> = {};
  if (conversationId) {
    query.conversationId = conversationId;
  }
  const { data, error, response } = await client.get<ListAppsResponse, unknown>(
    {
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/apps",
      path: { assistant_id: assistantId },
      query,
      throwOnError: false,
    },
  );
  assertHasResponse(response, error, "Failed to list apps.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to list apps.");
    throw new ApiError(response.status, msg);
  }
  const payload = data as ListAppsResponse | undefined;
  return payload?.apps ?? [];
}

/**
 * Permanently delete an app from the assistant daemon. Hits
 * `POST /v1/assistants/:id/apps/:appId/delete` through the wildcard proxy.
 * Also evicts any cached HTML for the deleted app so subsequent reads of the
 * same id (should one ever be reused) don't return a stale render.
 */
export async function deleteApp(
  assistantId: string,
  appId: string,
): Promise<void> {
  const { error, response } = await client.post<{ success: boolean }, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/apps/{app_id}/delete",
    path: { assistant_id: assistantId, app_id: appId },
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
  // Step 1: Create the share link (packages the app server-side)
  const { data, error, response } = await client.post<ShareAppCloudResponse, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/apps/{app_id}/share-cloud",
    path: { assistant_id: assistantId, app_id: appId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to share app.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to share app.");
    throw new ApiError(response.status, msg);
  }
  const payload = data as ShareAppCloudResponse | undefined;
  if (!payload?.shareToken) {
    throw new ApiError(500, "Share response missing token.");
  }

  // Step 2: Download the .vellum bundle binary
  const { response: dlResponse } = await client.get<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/apps/shared/{token}",
    path: { assistant_id: assistantId, token: payload.shareToken },
    throwOnError: false,
    parseAs: "stream",
  });
  if (!dlResponse || !dlResponse.ok) {
    throw new ApiError(dlResponse?.status ?? 500, "Failed to download app bundle.");
  }
  const blob = await dlResponse.blob();

  // Step 3: Trigger browser download
  const safeName = appName.replace(/[/\\:*?"<>|]/g, "_").trim() || "App";
  await saveFile(blob, `${safeName}.vellum`);
}

/**
 * Import a `.vellum` bundle file into the assistant daemon.
 *
 * Sends the raw file bytes as `application/octet-stream` to
 * `POST /v1/assistants/:id/apps/import-bundle` through the wildcard proxy.
 * We use octet-stream (not multipart) because the Django wildcard proxy only
 * forwards `application/octet-stream` as raw binary — multipart is parsed by
 * DRF which drops the file from the forwarded body.
 */
export async function importBundle(
  assistantId: string,
  file: File,
): Promise<ImportBundleResponse> {
  const bytes = await file.arrayBuffer();
  const { data, error, response } = await client.post<ImportBundleResponse, unknown>({
    ...SDK_BASE_OPTIONS,
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
  return data as ImportBundleResponse;
}

/**
 * Open an app — compiles if needed and returns the rendered HTML.
 *
 * Hits `POST /v1/apps/:id/open` through the wildcard proxy.
 */
export async function openApp(
  assistantId: string,
  appId: string,
): Promise<AppOpenResponse> {
  const { data, error, response } = await client.post<
    AppOpenResponse,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/apps/{app_id}/open",
    path: { assistant_id: assistantId, app_id: appId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to open app.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to open app.");
    throw new ApiError(response.status, msg);
  }
  return data as AppOpenResponse;
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

/**
 * Get the rendered HTML for an app, fetching once and caching the promise.
 * Concurrent callers share the same in-flight request.
 */
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

/** Seed the cache with HTML returned from a direct `openApp` call. */
export function primeAppHtmlCache(
  assistantId: string,
  appId: string,
  html: string,
): void {
  htmlCache.set(cacheKey(assistantId, appId), Promise.resolve(html));
}

/** Drop a single (assistant, appId) entry from the in-memory HTML cache. */
export function clearAppHtmlCache(assistantId: string, appId: string): void {
  htmlCache.delete(cacheKey(assistantId, appId));
}
