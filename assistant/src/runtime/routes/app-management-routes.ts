/**
 * HTTP route definitions for app CRUD, bundling, sharing, versioning,
 * gallery, and signing operations.
 *
 * Business logic is extracted from the IPC handlers in
 * `daemon/handlers/apps.ts`, `daemon/handlers/publish.ts`,
 * `daemon/handlers/signing.ts`, and `daemon/handlers/open-bundle-handler.ts`
 * so that the same operations are available over HTTP.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { packageApp } from "../../bundler/app-bundler.js";
import { compileApp } from "../../bundler/app-compiler.js";
import { scanBundle } from "../../bundler/bundle-scanner.js";
import { verifyBundleSignature } from "../../bundler/signature-verifier.js";
import { defaultGallery } from "../../gallery/default-gallery.js";
import { resolveHomeBaseAppId } from "../../home-base/bootstrap.js";
import { isPrebuiltHomeBaseApp } from "../../home-base/prebuilt-home-base-updater.js";
import {
  getAppDiff,
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
  isMultifileApp,
  listApps,
  queryAppRecords,
  updateApp,
  updateAppRecord,
} from "../../memory/app-store.js";
import { createSharedAppLink } from "../../memory/shared-app-links-store.js";
import { computeContentId } from "../../util/content-id.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("app-management-routes");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSharedAppsDir(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "vellum-assistant",
    "shared-apps",
  );
}

/** Compare two semver strings. Returns negative if a < b, 0 if equal, positive if a > b. */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Extracted business logic
// ---------------------------------------------------------------------------

function listAppsFiltered(): Array<{
  id: string;
  name: string;
  description?: string;
  icon?: string;
  createdAt: number;
  version: string;
  contentId: string;
}> {
  const allApps = listApps();
  const homeBaseId = resolveHomeBaseAppId();

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

  return allApps
    .filter((a) => {
      if (excludeIds.has(a.id)) return false;
      if (isPrebuiltHomeBaseApp(a)) return false;
      return true;
    })
    .map((a) => {
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
    });
}

function getAppDataResult(
  method: string,
  appId: string,
  recordId?: string,
  data?: Record<string, unknown>,
): unknown {
  switch (method) {
    case "query":
      return queryAppRecords(appId);
    case "create":
      if (!data) throw new Error("data is required for create");
      return createAppRecord(appId, data);
    case "update":
      if (!recordId) throw new Error("recordId is required for update");
      if (!data) throw new Error("data is required for update");
      return updateAppRecord(appId, recordId, data);
    case "delete":
      if (!recordId) throw new Error("recordId is required for delete");
      deleteAppRecord(appId, recordId);
      return null;
    default:
      throw new Error(`Unknown app data method: ${method}`);
  }
}

function listSharedApps(): Array<Record<string, unknown>> {
  const dir = getSharedAppsDir();
  if (!existsSync(dir)) {
    return [];
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
  const contentIdVersions = new Map<string, string[]>();
  for (const app of apps) {
    if (app.contentId && !app.forked) {
      const versions = contentIdVersions.get(app.contentId) ?? [];
      if (app.version) versions.push(app.version);
      contentIdVersions.set(app.contentId, versions);
    }
  }

  const latestVersions = new Map<string, string>();
  for (const [cid, versions] of contentIdVersions) {
    if (versions.length > 0) {
      versions.sort((a, b) => compareSemver(a, b));
      latestVersions.set(cid, versions[versions.length - 1]);
    }
  }

  return apps.map((app) => {
    let updateAvailable = false;
    if (app.contentId && app.version && !app.forked) {
      const latest = latestVersions.get(app.contentId);
      if (latest && compareSemver(app.version, latest) < 0) {
        updateAvailable = true;
      }
    }
    const { forked: _, ...rest } = app;
    return { ...rest, updateAvailable: updateAvailable || undefined };
  });
}

function deleteSharedApp(uuid: string): boolean {
  if (uuid.includes("/") || uuid.includes("\\") || uuid.includes("..")) {
    return false;
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

  return true;
}

function forkSharedApp(
  appUuid: string,
): { success: true; appId: string; name: string } | { success: false; error: string } {
  if (
    appUuid.includes("/") ||
    appUuid.includes("\\") ||
    appUuid.includes("..") ||
    /\s/.test(appUuid)
  ) {
    return { success: false, error: "Invalid UUID" };
  }

  const dir = getSharedAppsDir();
  const metaFile = join(dir, `${appUuid}-meta.json`);

  if (!existsSync(metaFile)) {
    return { success: false, error: "Shared app not found" };
  }

  const metaRaw = readFileSync(metaFile, "utf-8");
  const meta = JSON.parse(metaRaw);
  const appName = meta.name ?? "Untitled";
  const appDescription = meta.description;

  const entry = meta.entry ?? "index.html";
  const htmlPath = join(dir, appUuid, entry);

  if (!existsSync(htmlPath)) {
    return { success: false, error: "Shared app HTML not found" };
  }

  const htmlContent = readFileSync(htmlPath, "utf-8");

  const newApp = createApp({
    name: `${appName} (Fork)`,
    description: appDescription,
    schemaJson: JSON.stringify({ type: "object", properties: {} }),
    htmlDefinition: htmlContent,
  });

  return { success: true, appId: newApp.id, name: newApp.name };
}

async function installGalleryApp(
  galleryAppId: string,
): Promise<{ success: true; appId: string; name: string } | { success: false; error: string }> {
  const galleryApp = defaultGallery.apps.find(
    (a) => a.id === galleryAppId,
  );
  if (!galleryApp) {
    return {
      success: false,
      error: `Gallery app not found: ${galleryAppId}`,
    };
  }

  const app = createApp({
    name: galleryApp.name,
    description: galleryApp.description,
    schemaJson: galleryApp.schemaJson,
    htmlDefinition: galleryApp.htmlDefinition,
    formatVersion: galleryApp.formatVersion,
  });

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

  return { success: true, appId: app.id, name: app.name };
}

async function openBundle(filePath: string): Promise<Record<string, unknown>> {
  const fileStat = await stat(filePath);
  const bundleSizeBytes = fileStat.size;

  const [scanResult, signatureResult] = await Promise.all([
    scanBundle(filePath),
    verifyBundleSignature(filePath),
  ]);

  const JSZip = (await import("jszip")).default;
  const fileData = await Bun.file(filePath).arrayBuffer();
  const zip = await JSZip.loadAsync(fileData);
  const manifestFile = zip.file("manifest.json");
  let manifest: Record<string, unknown>;
  if (manifestFile) {
    const manifestText = await manifestFile.async("text");
    manifest = JSON.parse(manifestText) as Record<string, unknown>;
  } else {
    manifest = {
      format_version: 0,
      name: "Unknown",
      created_at: "",
      created_by: "",
      entry: "",
      capabilities: [],
    };
  }

  const blocked = scanResult.findings
    .filter((f) => f.level === "block")
    .map((f) => f.message);
  const warnings = scanResult.findings
    .filter((f) => f.level === "warn")
    .map((f) => f.message);

  return {
    manifest,
    scanResult: {
      passed: scanResult.passed,
      blocked,
      warnings,
    },
    signatureResult: {
      trustTier: signatureResult.trustTier,
      signerKeyId: signatureResult.signerKeyId,
      signerDisplayName: signatureResult.signerDisplayName,
      signerAccount: signatureResult.signerAccount,
    },
    bundleSizeBytes,
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function appManagementRouteDefinitions(): RouteDefinition[] {
  return [
    // -----------------------------------------------------------------------
    // Literal path routes MUST come before parameterized `apps/:id/*` routes
    // to prevent the `:id` param from capturing "shared", "fork", etc.
    // -----------------------------------------------------------------------

    // --- App list ---

    {
      endpoint: "apps",
      method: "GET",
      policyKey: "apps",
      handler: () => {
        try {
          const apps = listAppsFiltered();
          return Response.json({ apps });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err }, "Failed to list apps");
          return httpError("INTERNAL_ERROR", `Failed to list apps: ${message}`, 500);
        }
      },
    },

    // --- Open bundle (no :id param) ---

    {
      endpoint: "apps/open-bundle",
      method: "POST",
      policyKey: "apps/open-bundle",
      handler: async ({ req }) => {
        try {
          const body = (await req.json()) as { filePath?: string };
          if (!body.filePath) {
            return httpError("BAD_REQUEST", "filePath is required", 400);
          }
          const result = await openBundle(body.filePath);
          return Response.json(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err }, "Failed to open bundle");
          return httpError(
            "INTERNAL_ERROR",
            `Failed to open bundle: ${message}`,
            500,
          );
        }
      },
    },

    // --- Shared apps list (literal "apps/shared" GET) ---
    // NOTE: The existing appRouteDefinitions() already handles
    // apps/shared/:token (GET/DELETE) — this new route uses a different
    // method (GET with no sub-path param) so there is no conflict.

    {
      endpoint: "apps/shared",
      method: "GET",
      policyKey: "apps/shared-list",
      handler: () => {
        try {
          const apps = listSharedApps();
          return Response.json({ apps });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err }, "Failed to list shared apps");
          return httpError(
            "INTERNAL_ERROR",
            `Failed to list shared apps: ${message}`,
            500,
          );
        }
      },
    },

    // --- Fork shared app ---

    {
      endpoint: "apps/fork",
      method: "POST",
      policyKey: "apps/fork",
      handler: async ({ req }) => {
        try {
          const body = (await req.json()) as { uuid?: string };
          if (!body.uuid) {
            return httpError("BAD_REQUEST", "uuid is required", 400);
          }
          const result = forkSharedApp(body.uuid);
          if (!result.success) {
            return Response.json(result, { status: 400 });
          }
          return Response.json(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err }, "Failed to fork shared app");
          return Response.json(
            { success: false, error: message },
            { status: 500 },
          );
        }
      },
    },

    // --- Gallery ---

    {
      endpoint: "apps/gallery/install",
      method: "POST",
      policyKey: "apps/gallery/install",
      handler: async ({ req }) => {
        try {
          const body = (await req.json()) as { galleryAppId?: string };
          if (!body.galleryAppId) {
            return httpError("BAD_REQUEST", "galleryAppId is required", 400);
          }
          const result = await installGalleryApp(body.galleryAppId);
          if (!result.success) {
            return Response.json(result, { status: 400 });
          }
          return Response.json(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err }, "Failed to install gallery app");
          return Response.json(
            { success: false, error: message },
            { status: 500 },
          );
        }
      },
    },

    {
      endpoint: "apps/gallery",
      method: "GET",
      policyKey: "apps/gallery",
      handler: () => {
        return Response.json({ gallery: defaultGallery });
      },
    },

    // --- Signing ---

    {
      endpoint: "apps/sign-bundle",
      method: "POST",
      policyKey: "apps/sign-bundle",
      handler: async ({ req }) => {
        try {
          const body = (await req.json()) as {
            payload?: string;
            signature?: string;
            keyId?: string;
            publicKey?: string;
          };
          if (!body.payload) {
            return httpError("BAD_REQUEST", "payload is required", 400);
          }
          // For HTTP-based signing, the client provides the signature
          // directly rather than using the IPC round-trip pattern.
          // Return the payload hash for the client to sign.
          return Response.json({
            payload: body.payload,
            message:
              "Sign the payload with your private key and include signature, keyId, and publicKey in the request body.",
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err }, "Failed to process sign-bundle request");
          return httpError(
            "INTERNAL_ERROR",
            `Failed to process sign-bundle: ${message}`,
            500,
          );
        }
      },
    },

    {
      endpoint: "apps/signing-identity",
      method: "GET",
      policyKey: "apps/signing-identity",
      handler: () => {
        // Signing identity is a client-side concept. Over HTTP, the
        // client already holds its own keys. Return a placeholder
        // indicating that signing is client-managed.
        return Response.json({
          message:
            "Signing identity is managed client-side. Use your local keychain to obtain keyId and publicKey.",
        });
      },
    },

    // -----------------------------------------------------------------------
    // Parameterized `apps/:id/*` routes — must follow all literal routes.
    // -----------------------------------------------------------------------

    // --- App data ---

    {
      endpoint: "apps/:id/data",
      method: "GET",
      policyKey: "apps/data",
      handler: ({ params, url }) => {
        try {
          const method = url.searchParams.get("method") ?? "query";
          const recordId = url.searchParams.get("recordId") ?? undefined;
          const result = getAppDataResult(method, params.id, recordId);
          return Response.json({ success: true, result });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err, appId: params.id }, "Error handling app data request");
          return Response.json({ success: false, error: message }, { status: 400 });
        }
      },
    },

    {
      endpoint: "apps/:id/data",
      method: "POST",
      policyKey: "apps/data",
      handler: async ({ params, req }) => {
        try {
          const body = (await req.json()) as {
            method?: string;
            recordId?: string;
            data?: Record<string, unknown>;
          };
          const method = body.method ?? "create";
          const result = getAppDataResult(
            method,
            params.id,
            body.recordId,
            body.data,
          );
          return Response.json({ success: true, result });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err, appId: params.id }, "Error handling app data request");
          return Response.json({ success: false, error: message }, { status: 400 });
        }
      },
    },

    // --- App open ---

    {
      endpoint: "apps/:id/open",
      method: "POST",
      policyKey: "apps/open",
      handler: async ({ params }) => {
        try {
          const appId = params.id;
          const app = getApp(appId);
          if (!app) {
            return httpError("NOT_FOUND", `App not found: ${appId}`, 404);
          }

          let html = app.htmlDefinition;

          if (isMultifileApp(app)) {
            const appDir = join(getAppsDir(), appId);
            const distIndex = join(appDir, "dist", "index.html");
            if (!existsSync(distIndex)) {
              const result = await compileApp(appDir);
              if (!result.ok) {
                log.warn(
                  { appId, errors: result.errors },
                  "Auto-compile failed on app open",
                );
              }
            }
            if (existsSync(distIndex)) {
              html = readFileSync(distIndex, "utf-8");
            } else {
              html = `<p>App compilation failed. Edit a source file to trigger a rebuild.</p>`;
            }
          }

          return Response.json({
            appId: app.id,
            name: app.name,
            html,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err, appId: params.id }, "Failed to handle app open request");
          return httpError(
            "INTERNAL_ERROR",
            `Failed to open app: ${message}`,
            500,
          );
        }
      },
    },

    // --- App delete ---

    {
      endpoint: "apps/:id/delete",
      method: "POST",
      policyKey: "apps/delete",
      handler: ({ params }) => {
        try {
          deleteApp(params.id);
          return Response.json({ success: true });
        } catch (err) {
          log.error({ err, appId: params.id }, "Failed to delete app");
          return Response.json({ success: false }, { status: 500 });
        }
      },
    },

    // --- Preview ---

    {
      endpoint: "apps/:id/preview",
      method: "GET",
      policyKey: "apps/preview",
      handler: ({ params }) => {
        try {
          const preview = getAppPreview(params.id);
          return Response.json({
            appId: params.id,
            preview: preview ?? null,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err, appId: params.id }, "Failed to get app preview");
          return httpError(
            "INTERNAL_ERROR",
            `Failed to get app preview: ${message}`,
            500,
          );
        }
      },
    },

    {
      endpoint: "apps/:id/preview",
      method: "PUT",
      policyKey: "apps/preview",
      handler: async ({ params, req }) => {
        try {
          const body = (await req.json()) as { preview?: string };
          if (!body.preview) {
            return httpError("BAD_REQUEST", "preview is required", 400);
          }
          updateApp(params.id, { preview: body.preview });
          return Response.json({ success: true, appId: params.id });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err }, "Failed to update app preview");
          return httpError(
            "INTERNAL_ERROR",
            `Failed to update app preview: ${message}`,
            500,
          );
        }
      },
    },

    // --- History / Diff / Restore ---

    {
      endpoint: "apps/:id/history",
      method: "GET",
      policyKey: "apps/history",
      handler: async ({ params, url }) => {
        try {
          const limit = url.searchParams.get("limit")
            ? Number(url.searchParams.get("limit"))
            : undefined;
          const versions = await getAppHistory(params.id, limit);
          return Response.json({ appId: params.id, versions });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err, appId: params.id }, "Failed to get app history");
          return httpError(
            "INTERNAL_ERROR",
            `Failed to get app history: ${message}`,
            500,
          );
        }
      },
    },

    {
      endpoint: "apps/:id/diff",
      method: "GET",
      policyKey: "apps/diff",
      handler: async ({ params, url }) => {
        try {
          const fromCommit = url.searchParams.get("fromCommit");
          if (!fromCommit) {
            return httpError(
              "BAD_REQUEST",
              "fromCommit query parameter is required",
              400,
            );
          }
          const toCommit =
            url.searchParams.get("toCommit") ?? undefined;
          const diff = await getAppDiff(params.id, fromCommit, toCommit);
          return Response.json({ appId: params.id, diff });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err, appId: params.id }, "Failed to get app diff");
          return httpError(
            "INTERNAL_ERROR",
            `Failed to get app diff: ${message}`,
            500,
          );
        }
      },
    },

    {
      endpoint: "apps/:id/restore",
      method: "POST",
      policyKey: "apps/restore",
      handler: async ({ params, req }) => {
        try {
          const body = (await req.json()) as { commitHash?: string };
          if (!body.commitHash) {
            return httpError("BAD_REQUEST", "commitHash is required", 400);
          }
          await restoreAppVersion(params.id, body.commitHash);
          return Response.json({ success: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err, appId: params.id }, "Failed to restore app version");
          return Response.json(
            { success: false, error: message },
            { status: 500 },
          );
        }
      },
    },

    // --- Bundle ---

    {
      endpoint: "apps/:id/bundle",
      method: "POST",
      policyKey: "apps/bundle",
      handler: async ({ params }) => {
        try {
          const result = await packageApp(params.id);
          return Response.json({
            bundlePath: result.bundlePath,
            iconImageBase64: result.iconImageBase64,
            manifest: result.manifest,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err, appId: params.id }, "Failed to bundle app");
          return httpError(
            "INTERNAL_ERROR",
            `Failed to bundle app: ${message}`,
            500,
          );
        }
      },
    },

    // --- Share to cloud ---

    {
      endpoint: "apps/:id/share-cloud",
      method: "POST",
      policyKey: "apps/share-cloud",
      handler: async ({ params }) => {
        try {
          // Package without signing callback (HTTP clients handle signing
          // separately or skip it). The IPC flow used a socket-based
          // signing callback; HTTP callers can use the sign-bundle
          // endpoint independently if needed.
          const result = await packageApp(params.id);
          const bundleData = readFileSync(result.bundlePath);
          const { shareToken } = createSharedAppLink(bundleData, result.manifest);

          const shareUrl = `/v1/apps/shared/${shareToken}`;

          return Response.json({
            success: true,
            shareToken,
            shareUrl,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err, appId: params.id }, "Failed to share app to cloud");
          return Response.json(
            { success: false, error: message },
            { status: 500 },
          );
        }
      },
    },
  ];
}
