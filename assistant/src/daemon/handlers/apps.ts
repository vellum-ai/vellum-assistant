import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as net from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { v4 as uuid } from "uuid";

import { packageApp } from "../../bundler/app-bundler.js";
import { compileApp } from "../../bundler/app-compiler.js";
import { defaultGallery } from "../../gallery/default-gallery.js";
import { resolveHomeBaseAppId } from "../../home-base/bootstrap.js";
import { isPrebuiltHomeBaseApp } from "../../home-base/prebuilt-home-base-updater.js";
import {
  getAppDiff,
  getAppFileAtVersion,
  getAppHistory,
  restoreAppVersion,
} from "../../memory/app-git-service.js";
import {
  createApp,
  createAppRecord,
  deleteApp,
  deleteAppRecord,
  getApp,
  getAppPreview,
  getAppsDir,
  listApps,
  queryAppRecords,
  updateApp,
  updateAppRecord,
} from "../../memory/app-store.js";
import { createSharedAppLink } from "../../memory/shared-app-links-store.js";
import { computeContentId } from "../../util/content-id.js";
import type {
  AppDataRequest,
  AppDeleteRequest,
  AppDiffRequest,
  AppFileAtVersionRequest,
  AppHistoryRequest,
  AppRestoreRequest,
  AppUpdatePreviewRequest,
  BundleAppRequest,
  ForkSharedAppRequest,
  GalleryInstallRequest,
  ShareAppCloudRequest,
  SharedAppDeleteRequest,
  UiSurfaceShow,
} from "../ipc-protocol.js";
import {
  compareSemver,
  createSigningCallback,
  defineHandlers,
  type HandlerContext,
  log,
} from "./shared.js";

export function handleAppDataRequest(
  msg: AppDataRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const { surfaceId, callId, method, appId, recordId, data } = msg;
  try {
    let result: unknown = null;
    switch (method) {
      case "query":
        result = queryAppRecords(appId);
        break;
      case "create":
        if (!data) throw new Error("data is required for create");
        result = createAppRecord(appId, data);
        break;
      case "update":
        if (!recordId) throw new Error("recordId is required for update");
        if (!data) throw new Error("data is required for update");
        result = updateAppRecord(appId, recordId, data);
        break;
      case "delete":
        if (!recordId) throw new Error("recordId is required for delete");
        deleteAppRecord(appId, recordId);
        result = null;
        break;
      default:
        throw new Error(`Unknown app data method: ${method}`);
    }
    ctx.send(socket, {
      type: "app_data_response",
      surfaceId,
      callId,
      success: true,
      result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err, method, appId, recordId },
      "Error handling app_data_request",
    );
    ctx.send(socket, {
      type: "app_data_response",
      surfaceId,
      callId,
      success: false,
      error: message,
    });
  }
}

export function handleAppOpenRequest(
  msg: { appId: string },
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const appId = msg.appId;
    if (!appId) {
      ctx.send(socket, {
        type: "error",
        message: "app_open_request requires appId",
      });
      return;
    }

    const app = getApp(appId);
    if (app) {
      const surfaceId = `app-open-${uuid()}`;
      ctx.send(socket, {
        type: "ui_surface_show",
        sessionId: "app-panel",
        surfaceId,
        surfaceType: "dynamic_page",
        title: app.name,
        data: { html: app.htmlDefinition, appId: app.id },
        display: "panel",
      } as UiSurfaceShow);
      return;
    }

    // Fallback: the ID might be a surfaceId from an ephemeral ui_show surface
    // (not a persistent app). Search active sessions for cached surface data.
    for (const session of ctx.sessions.values()) {
      const cached = session.surfaceState.get(appId);
      if (cached && cached.surfaceType === "dynamic_page") {
        const newSurfaceId = `app-open-${uuid()}`;
        ctx.send(socket, {
          type: "ui_surface_show",
          sessionId: "app-panel",
          surfaceId: newSurfaceId,
          surfaceType: "dynamic_page",
          title:
            cached.title ??
            (cached.data as { preview?: { title?: string } }).preview?.title,
          data: cached.data,
          display: "panel",
        } as UiSurfaceShow);
        return;
      }
    }

    log.warn({ appId }, "App not found in store or session surfaces");
    ctx.send(socket, { type: "error", message: `App not found: ${appId}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appId: msg.appId }, "Failed to handle app open request");
    ctx.send(socket, {
      type: "error",
      message: `Failed to open app: ${message}`,
    });
  }
}

export function handleAppUpdatePreview(
  msg: AppUpdatePreviewRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    updateApp(msg.appId, { preview: msg.preview });
    ctx.send(socket, {
      type: "app_update_preview_response",
      success: true,
      appId: msg.appId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to update app preview");
    ctx.send(socket, {
      type: "error",
      message: `Failed to update app preview: ${message}`,
    });
  }
}

export function handleAppsList(socket: net.Socket, ctx: HandlerContext): void {
  try {
    const allApps = listApps();
    const homeBaseId = resolveHomeBaseAppId();

    // When no home base was found by ID, do a single targeted search for an app
    // matching the HTML marker. listApps() returns metadata-only (no htmlDefinition),
    // so the HTML marker check requires loading the full app from disk. We limit
    // this expensive operation to the case where homeBaseId is null.
    const excludeIds = new Set<string>();
    if (homeBaseId) {
      excludeIds.add(homeBaseId);
    } else {
      for (const a of allApps) {
        if (isPrebuiltHomeBaseApp(a)) {
          excludeIds.add(a.id);
          continue;
        }
        const fullApp = getApp(a.id);
        if (fullApp && isPrebuiltHomeBaseApp(fullApp)) {
          excludeIds.add(a.id);
          continue;
        }
      }
    }

    const apps = allApps.filter((a) => {
      if (excludeIds.has(a.id)) return false;
      if (isPrebuiltHomeBaseApp(a)) return false;
      return true;
    });
    ctx.send(socket, {
      type: "apps_list_response",
      apps: apps.map((a) => {
        const version = a.version ?? "1.0.0";
        const contentId = computeContentId(a.name);
        return {
          id: a.id,
          name: a.name,
          description: a.description,
          icon: a.icon,
          createdAt: a.createdAt,
          version,
          contentId,
        };
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to list apps");
    ctx.send(socket, {
      type: "error",
      message: `Failed to list apps: ${message}`,
    });
  }
}

export function handleAppPreview(
  msg: { appId: string },
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const preview = getAppPreview(msg.appId);
    ctx.send(socket, {
      type: "app_preview_response",
      appId: msg.appId,
      preview: preview ?? undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appId: msg.appId }, "Failed to get app preview");
    ctx.send(socket, {
      type: "error",
      message: `Failed to get app preview: ${message}`,
    });
  }
}

export function handleAppDelete(
  msg: AppDeleteRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    deleteApp(msg.appId);
    ctx.send(socket, { type: "app_delete_response", success: true });
  } catch (err) {
    log.error({ err, appId: msg.appId }, "Failed to delete app");
    ctx.send(socket, { type: "app_delete_response", success: false });
  }
}

function getSharedAppsDir(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "vellum-assistant",
    "shared-apps",
  );
}

export function handleSharedAppsList(
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const dir = getSharedAppsDir();
    if (!existsSync(dir)) {
      ctx.send(socket, { type: "shared_apps_list_response", apps: [] });
      return;
    }

    const files = readdirSync(dir).filter((f) => f.endsWith("-meta.json"));
    const apps: Array<{
      uuid: string;
      name: string;
      description?: string;
      icon?: string;
      preview?: string;
      entry: string;
      trustTier: string;
      signerDisplayName?: string;
      bundleSizeBytes: number;
      installedAt: string;
      version?: string;
      contentId?: string;
      forked?: boolean;
    }> = [];

    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), "utf-8");
        const meta = JSON.parse(raw);

        // Try to read version and content_id from the manifest.json inside the app dir
        let version: string | undefined;
        let contentId: string | undefined;
        const manifestPath = join(dir, meta.uuid, "manifest.json");
        if (existsSync(manifestPath)) {
          try {
            const manifestRaw = readFileSync(manifestPath, "utf-8");
            const manifest = JSON.parse(manifestRaw);
            version = manifest.version;
            contentId = manifest.content_id;
          } catch {
            // ignore malformed manifest
          }
        }

        apps.push({
          uuid: meta.uuid,
          name: meta.name,
          description: meta.description,
          icon: meta.icon,
          preview: meta.preview,
          entry: meta.entry,
          trustTier: meta.trustTier,
          signerDisplayName: meta.signerDisplayName,
          bundleSizeBytes: meta.bundleSizeBytes ?? 0,
          installedAt: meta.installedAt,
          version,
          contentId,
          forked: meta.forked,
        });
      } catch {
        log.warn({ file }, "Failed to read shared app metadata file");
      }
    }

    // Detect update availability for non-forked shared apps.
    // Group by contentId, then mark older versions as having an update available.
    const contentIdVersions = new Map<string, string[]>();
    for (const app of apps) {
      if (app.contentId && !app.forked) {
        const versions = contentIdVersions.get(app.contentId) ?? [];
        if (app.version) versions.push(app.version);
        contentIdVersions.set(app.contentId, versions);
      }
    }

    // Find the latest version for each contentId
    const latestVersions = new Map<string, string>();
    for (const [cid, versions] of contentIdVersions) {
      if (versions.length > 0) {
        versions.sort((a, b) => compareSemver(a, b));
        latestVersions.set(cid, versions[versions.length - 1]);
      }
    }

    const result = apps.map((app) => {
      let updateAvailable = false;
      if (app.contentId && app.version && !app.forked) {
        const latest = latestVersions.get(app.contentId);
        if (latest && compareSemver(app.version, latest) < 0) {
          updateAvailable = true;
        }
      }
      // Remove the internal forked field before sending
      const { forked: _, ...rest } = app;
      return { ...rest, updateAvailable: updateAvailable || undefined };
    });

    ctx.send(socket, { type: "shared_apps_list_response", apps: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to list shared apps");
    ctx.send(socket, {
      type: "error",
      message: `Failed to list shared apps: ${message}`,
    });
  }
}

export function handleSharedAppDelete(
  msg: SharedAppDeleteRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const uuid = msg.uuid;
    // Validate UUID to prevent path traversal
    if (uuid.includes("/") || uuid.includes("\\") || uuid.includes("..")) {
      ctx.send(socket, { type: "shared_app_delete_response", success: false });
      return;
    }

    const dir = getSharedAppsDir();
    const appDir = join(dir, uuid);
    const metaFile = join(dir, `${uuid}-meta.json`);

    if (existsSync(appDir)) {
      rmSync(appDir, { recursive: true });
    }
    if (existsSync(metaFile)) {
      rmSync(metaFile);
    }

    ctx.send(socket, { type: "shared_app_delete_response", success: true });
  } catch (err) {
    log.error({ err }, "Failed to delete shared app");
    ctx.send(socket, { type: "shared_app_delete_response", success: false });
  }
}

export function handleForkSharedApp(
  msg: ForkSharedAppRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const appUuid = msg.uuid;
    // Validate UUID to prevent path traversal
    if (
      appUuid.includes("/") ||
      appUuid.includes("\\") ||
      appUuid.includes("..") ||
      /\s/.test(appUuid)
    ) {
      ctx.send(socket, {
        type: "fork_shared_app_response",
        success: false,
        error: "Invalid UUID",
      });
      return;
    }

    const dir = getSharedAppsDir();
    const metaFile = join(dir, `${appUuid}-meta.json`);

    if (!existsSync(metaFile)) {
      ctx.send(socket, {
        type: "fork_shared_app_response",
        success: false,
        error: "Shared app not found",
      });
      return;
    }

    const metaRaw = readFileSync(metaFile, "utf-8");
    const meta = JSON.parse(metaRaw);
    const appName = meta.name ?? "Untitled";
    const appDescription = meta.description;

    // Read the HTML from the shared app's entry file
    const entry = meta.entry ?? "index.html";
    const htmlPath = join(dir, appUuid, entry);

    if (!existsSync(htmlPath)) {
      ctx.send(socket, {
        type: "fork_shared_app_response",
        success: false,
        error: "Shared app HTML not found",
      });
      return;
    }

    const htmlContent = readFileSync(htmlPath, "utf-8");

    // Create a new local app via the app store
    const newApp = createApp({
      name: `${appName} (Fork)`,
      description: appDescription,
      schemaJson: JSON.stringify({ type: "object", properties: {} }),
      htmlDefinition: htmlContent,
    });

    ctx.send(socket, {
      type: "fork_shared_app_response",
      success: true,
      appId: newApp.id,
      name: newApp.name,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to fork shared app");
    ctx.send(socket, {
      type: "fork_shared_app_response",
      success: false,
      error: message,
    });
  }
}

export async function handleShareAppCloud(
  msg: ShareAppCloudRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const result = await packageApp(
      msg.appId,
      createSigningCallback(socket, ctx),
    );
    const bundleData = readFileSync(result.bundlePath);
    const { shareToken } = createSharedAppLink(bundleData, result.manifest);

    const shareUrl = `/v1/apps/shared/${shareToken}`;

    ctx.send(socket, {
      type: "share_app_cloud_response",
      success: true,
      shareToken,
      shareUrl,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appId: msg.appId }, "Failed to share app to cloud");
    ctx.send(socket, {
      type: "share_app_cloud_response",
      success: false,
      error: message,
    });
  }
}

export async function handleBundleApp(
  msg: BundleAppRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const result = await packageApp(
      msg.appId,
      createSigningCallback(socket, ctx),
    );
    ctx.send(socket, {
      type: "bundle_app_response",
      bundlePath: result.bundlePath,
      iconImageBase64: result.iconImageBase64,
      manifest: result.manifest,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appId: msg.appId }, "Failed to bundle app");
    ctx.send(socket, {
      type: "error",
      message: `Failed to bundle app: ${message}`,
    });
  }
}

export function handleGalleryList(
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  ctx.send(socket, { type: "gallery_list_response", gallery: defaultGallery });
}

export async function handleGalleryInstall(
  msg: GalleryInstallRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const galleryApp = defaultGallery.apps.find(
      (a) => a.id === msg.galleryAppId,
    );
    if (!galleryApp) {
      ctx.send(socket, {
        type: "gallery_install_response",
        success: false,
        error: `Gallery app not found: ${msg.galleryAppId}`,
      });
      return;
    }

    const app = createApp({
      name: galleryApp.name,
      description: galleryApp.description,
      schemaJson: galleryApp.schemaJson,
      htmlDefinition: galleryApp.htmlDefinition,
      formatVersion: galleryApp.formatVersion,
    });

    // For multifile apps, write source files to the app directory and compile
    if (galleryApp.formatVersion === 2 && galleryApp.sourceFiles) {
      const appDir = join(getAppsDir(), app.id);
      for (const [relPath, content] of Object.entries(galleryApp.sourceFiles)) {
        const fullPath = join(appDir, relPath);
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content, "utf-8");
      }
      const result = await compileApp(appDir);
      if (!result.ok) {
        log.warn(
          { appId: app.id, errors: result.errors },
          "Gallery app compilation had errors; falling back to htmlDefinition",
        );
      }
    }

    ctx.send(socket, {
      type: "gallery_install_response",
      success: true,
      appId: app.id,
      name: app.name,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err, galleryAppId: msg.galleryAppId },
      "Failed to install gallery app",
    );
    ctx.send(socket, {
      type: "gallery_install_response",
      success: false,
      error: message,
    });
  }
}

export async function handleAppHistory(
  msg: AppHistoryRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const versions = await getAppHistory(msg.appId, msg.limit);
    ctx.send(socket, {
      type: "app_history_response",
      appId: msg.appId,
      versions,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appId: msg.appId }, "Failed to get app history");
    ctx.send(socket, {
      type: "error",
      message: `Failed to get app history: ${message}`,
    });
  }
}

export async function handleAppDiff(
  msg: AppDiffRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const diff = await getAppDiff(msg.appId, msg.fromCommit, msg.toCommit);
    ctx.send(socket, { type: "app_diff_response", appId: msg.appId, diff });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appId: msg.appId }, "Failed to get app diff");
    ctx.send(socket, {
      type: "error",
      message: `Failed to get app diff: ${message}`,
    });
  }
}

export async function handleAppFileAtVersion(
  msg: AppFileAtVersionRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const content = await getAppFileAtVersion(
      msg.appId,
      msg.path,
      msg.commitHash,
    );
    ctx.send(socket, {
      type: "app_file_at_version_response",
      appId: msg.appId,
      path: msg.path,
      content,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appId: msg.appId }, "Failed to get app file at version");
    ctx.send(socket, {
      type: "error",
      message: `Failed to get app file at version: ${message}`,
    });
  }
}

export async function handleAppRestore(
  msg: AppRestoreRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    await restoreAppVersion(msg.appId, msg.commitHash);
    ctx.send(socket, { type: "app_restore_response", success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appId: msg.appId }, "Failed to restore app version");
    ctx.send(socket, {
      type: "app_restore_response",
      success: false,
      error: message,
    });
  }
}

export const appHandlers = defineHandlers({
  app_data_request: handleAppDataRequest,
  app_open_request: handleAppOpenRequest,
  app_update_preview: handleAppUpdatePreview,
  app_preview_request: handleAppPreview,
  apps_list: (_msg, socket, ctx) => handleAppsList(socket, ctx),
  shared_apps_list: (_msg, socket, ctx) => handleSharedAppsList(socket, ctx),
  app_delete: handleAppDelete,
  shared_app_delete: handleSharedAppDelete,
  fork_shared_app: handleForkSharedApp,
  share_app_cloud: handleShareAppCloud,
  bundle_app: handleBundleApp,
  gallery_list: (_msg, socket, ctx) => handleGalleryList(socket, ctx),
  gallery_install: handleGalleryInstall,
  app_history_request: handleAppHistory,
  app_diff_request: handleAppDiff,
  app_file_at_version_request: handleAppFileAtVersion,
  app_restore_request: handleAppRestore,
});
