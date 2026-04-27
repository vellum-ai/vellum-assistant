/**
 * Route handlers for app CRUD, bundling, sharing, versioning,
 * gallery, and signing operations.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import { packageApp } from "../../bundler/app-bundler.js";
import { compileApp } from "../../bundler/app-compiler.js";
import { scanBundle } from "../../bundler/bundle-scanner.js";
import type { SignatureJson } from "../../bundler/bundle-signer.js";
import { verifyBundleSignature } from "../../bundler/signature-verifier.js";
import { compareSemver } from "../../daemon/handlers/shared.js";
import { defaultGallery } from "../../gallery/default-gallery.js";
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
  getAppDirPath,
  getAppPreview,
  isMultifileApp,
  listApps,
  queryAppRecords,
  resolveAppDir,
  resolveEffectiveAppHtml,
  updateApp,
  updateAppRecord,
} from "../../memory/app-store.js";
import { createSharedAppLink } from "../../memory/shared-app-links-store.js";
import { computeContentId } from "../../util/content-id.js";
import { getLogger } from "../../util/logger.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

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
  return listApps().map((a) => {
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
      if (!data) throw new BadRequestError("data is required for create");
      return createAppRecord(appId, data);
    case "update":
      if (!recordId)
        throw new BadRequestError("recordId is required for update");
      if (!data) throw new BadRequestError("data is required for update");
      return updateAppRecord(appId, recordId, data);
    case "delete":
      if (!recordId)
        throw new BadRequestError("recordId is required for delete");
      deleteAppRecord(appId, recordId);
      return null;
    default:
      throw new BadRequestError(`Unknown app data method: ${method}`);
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

function forkSharedApp(
  appUuid: string,
):
  | { success: true; appId: string; name: string }
  | { success: false; error: string } {
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
): Promise<
  | { success: true; appId: string; name: string }
  | { success: false; error: string }
> {
  const galleryApp = defaultGallery.apps.find((a) => a.id === galleryAppId);
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
    const appDir = getAppDirPath(app.id);
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
// Route handlers
// ---------------------------------------------------------------------------

function handleListApps() {
  return { apps: listAppsFiltered() };
}

async function handleOpenBundle({ body }: RouteHandlerArgs) {
  if (!body?.filePath) {
    throw new BadRequestError("filePath is required");
  }
  return openBundle(body.filePath as string);
}

function handleListSharedApps() {
  return { apps: listSharedApps() };
}

function handleForkSharedApp({ body }: RouteHandlerArgs) {
  if (!body?.uuid) {
    throw new BadRequestError("uuid is required");
  }
  const result = forkSharedApp(body.uuid as string);
  if (!result.success) {
    throw new BadRequestError(result.error);
  }
  return result;
}

async function handleInstallGalleryApp({ body }: RouteHandlerArgs) {
  if (!body?.galleryAppId) {
    throw new BadRequestError("galleryAppId is required");
  }
  const result = await installGalleryApp(body.galleryAppId as string);
  if (!result.success) {
    throw new BadRequestError(result.error);
  }
  return result;
}

function handleListGallery() {
  return { gallery: defaultGallery };
}

function handleSignBundle({ body }: RouteHandlerArgs) {
  if (!body?.payload) {
    throw new BadRequestError("payload is required");
  }

  const payload = body.payload as string;
  const signature = body.signature as string | undefined;
  const keyId = body.keyId as string | undefined;
  const publicKey = body.publicKey as string | undefined;

  if (signature && keyId && publicKey) {
    let contentHashes: Record<string, string> = {};
    try {
      const parsed = JSON.parse(payload) as {
        content_hashes?: Record<string, string>;
      };
      contentHashes = parsed.content_hashes ?? {};
    } catch {
      throw new BadRequestError("payload is not valid JSON");
    }

    const signatureJson: SignatureJson = {
      algorithm: "ed25519",
      signer: {
        key_id: keyId,
        display_name: "HTTP Signer",
      },
      content_hashes: contentHashes,
      signature,
    };
    return { signed: true, signatureJson };
  }

  return {
    payload,
    message:
      "Sign the payload with your private key and include signature, keyId, and publicKey in the request body.",
  };
}

function handleSigningIdentity() {
  return {
    message:
      "Signing identity is managed client-side. Use your local keychain to obtain keyId and publicKey.",
  };
}

function handleQueryAppData({ pathParams, queryParams }: RouteHandlerArgs) {
  const appId = pathParams?.id as string;
  const method = queryParams?.method ?? "query";
  if (method !== "query") {
    throw new BadRequestError(
      "GET app-data only supports method=query; use POST for mutations",
    );
  }
  const result = getAppDataResult(method, appId);
  return { success: true, result };
}

function handleMutateAppData({ pathParams, body }: RouteHandlerArgs) {
  const appId = pathParams?.id as string;
  const method = (body?.method as string) ?? "create";
  const result = getAppDataResult(
    method,
    appId,
    body?.recordId as string | undefined,
    body?.data as Record<string, unknown> | undefined,
  );
  return { success: true, result };
}

async function handleOpenApp({ pathParams }: RouteHandlerArgs) {
  const appId = pathParams?.id as string;
  const app = getApp(appId);
  if (!app) {
    throw new NotFoundError(`App not found: ${appId}`);
  }

  if (isMultifileApp(app)) {
    const appDir = getAppDirPath(appId);
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
  }
  const html = resolveEffectiveAppHtml(app);
  const { dirName } = resolveAppDir(app.id);
  return { appId: app.id, dirName, name: app.name, html };
}

function handleDeleteApp({ pathParams }: RouteHandlerArgs) {
  deleteApp(pathParams?.id as string);
  return { success: true };
}

function handleGetPreview({ pathParams }: RouteHandlerArgs) {
  const appId = pathParams?.id as string;
  const preview = getAppPreview(appId);
  return { appId, preview: preview ?? null };
}

function handleUpdatePreview({ pathParams, body }: RouteHandlerArgs) {
  const appId = pathParams?.id as string;
  if (!body?.preview) {
    throw new BadRequestError("preview is required");
  }
  updateApp(appId, { preview: body.preview as string });
  return { success: true, appId };
}

async function handleGetHistory({
  pathParams,
  queryParams,
}: RouteHandlerArgs) {
  const appId = pathParams?.id as string;
  const limit = queryParams?.limit ? Number(queryParams.limit) : undefined;
  const versions = await getAppHistory(appId, limit);
  return { appId, versions };
}

async function handleGetDiff({ pathParams, queryParams }: RouteHandlerArgs) {
  const appId = pathParams?.id as string;
  const fromCommit = queryParams?.fromCommit;
  if (!fromCommit) {
    throw new BadRequestError("fromCommit query parameter is required");
  }
  const toCommit = queryParams?.toCommit;
  const diff = await getAppDiff(appId, fromCommit, toCommit);
  return { appId, diff };
}

async function handleRestore({ pathParams, body }: RouteHandlerArgs) {
  const appId = pathParams?.id as string;
  if (!body?.commitHash) {
    throw new BadRequestError("commitHash is required");
  }
  await restoreAppVersion(appId, body.commitHash as string);
  return { success: true };
}

async function handleBundle({ pathParams }: RouteHandlerArgs) {
  const appId = pathParams?.id as string;
  const result = await packageApp(appId);
  return {
    type: "bundle_app_response",
    bundlePath: result.bundlePath,
    iconImageBase64: result.iconImageBase64,
    manifest: result.manifest,
  };
}

async function handleShareCloud({ pathParams }: RouteHandlerArgs) {
  const appId = pathParams?.id as string;
  const result = await packageApp(appId);
  const bundleData = readFileSync(result.bundlePath);
  const { shareToken } = createSharedAppLink(bundleData, result.manifest);
  const shareUrl = `/v1/apps/shared/${shareToken}`;
  return { success: true, shareToken, shareUrl };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  // Literal path routes MUST come before parameterized `apps/:id/*` routes
  // to prevent the `:id` param from capturing "shared", "fork", etc.

  {
    operationId: "apps_list",
    endpoint: "apps",
    method: "GET",
    policyKey: "apps",
    handler: handleListApps,
    summary: "List apps",
    description: "Return all locally installed apps.",
    tags: ["apps"],
    responseBody: z.object({
      apps: z.array(z.unknown()).describe("Array of app summary objects"),
    }),
  },
  {
    operationId: "apps_open_bundle",
    endpoint: "apps/open-bundle",
    method: "POST",
    policyKey: "apps/open-bundle",
    handler: handleOpenBundle,
    summary: "Open a .vbundle file",
    description:
      "Scan and validate a .vbundle file from disk and return its manifest.",
    tags: ["apps"],
    requestBody: z.object({
      filePath: z.string().describe("Absolute path to the .vbundle file"),
    }),
  },
  {
    operationId: "apps_shared_list",
    endpoint: "apps/shared",
    method: "GET",
    policyKey: "apps/shared-list",
    handler: handleListSharedApps,
    summary: "List shared apps",
    description: "Return all apps available via cloud share links.",
    tags: ["apps"],
    responseBody: z.object({
      apps: z.array(z.unknown()).describe("Array of shared app objects"),
    }),
  },
  {
    operationId: "apps_fork",
    endpoint: "apps/fork",
    method: "POST",
    policyKey: "apps/fork",
    handler: handleForkSharedApp,
    summary: "Fork a shared app",
    description: "Create a local copy of a shared app by its UUID.",
    tags: ["apps"],
    requestBody: z.object({
      uuid: z.string().describe("UUID of the shared app to fork"),
    }),
  },
  {
    operationId: "apps_gallery_install",
    endpoint: "apps/gallery/install",
    method: "POST",
    policyKey: "apps/gallery/install",
    handler: handleInstallGalleryApp,
    summary: "Install a gallery app",
    description: "Install an app from the built-in gallery by its ID.",
    tags: ["apps"],
    requestBody: z.object({ galleryAppId: z.string() }),
  },
  {
    operationId: "apps_gallery_list",
    endpoint: "apps/gallery",
    method: "GET",
    policyKey: "apps/gallery",
    handler: handleListGallery,
    summary: "List gallery apps",
    description: "Return the built-in app gallery catalog.",
    tags: ["apps"],
    responseBody: z.object({
      gallery: z.array(z.unknown()).describe("Gallery app entries"),
    }),
  },
  {
    operationId: "apps_sign_bundle",
    endpoint: "apps/sign-bundle",
    method: "POST",
    policyKey: "apps/sign-bundle",
    handler: handleSignBundle,
    summary: "Sign an app bundle",
    description:
      "Return a signing payload or complete the signing step when signature fields are provided.",
    tags: ["apps"],
    requestBody: z.object({
      payload: z.string().describe("Canonical JSON payload to sign"),
      signature: z.string().optional(),
      keyId: z.string().optional(),
      publicKey: z.string().optional(),
    }),
  },
  {
    operationId: "apps_signing_identity",
    endpoint: "apps/signing-identity",
    method: "GET",
    policyKey: "apps/signing-identity",
    handler: handleSigningIdentity,
    summary: "Get signing identity",
    description:
      "Return signing identity info. Signing is managed client-side over HTTP.",
    tags: ["apps"],
  },

  // Parameterized `apps/:id/*` routes — must follow all literal routes.

  {
    operationId: "apps_data_query",
    endpoint: "apps/:id/data",
    method: "GET",
    policyKey: "apps/data",
    handler: handleQueryAppData,
    summary: "Query app data",
    description: "Read records from an app's local data store.",
    tags: ["apps"],
    queryParams: [
      {
        name: "method",
        type: "string",
      },
    ],
  },
  {
    operationId: "apps_data_mutate",
    endpoint: "apps/:id/data",
    method: "POST",
    policyKey: "apps/data",
    handler: handleMutateAppData,
    summary: "Mutate app data",
    description:
      "Create, update, or delete records in an app's local data store.",
    tags: ["apps"],
    requestBody: z.object({
      method: z.string().describe("'create', 'update', or 'delete'"),
      recordId: z.string(),
      data: z.object({}).passthrough(),
    }),
  },
  {
    operationId: "apps_open",
    endpoint: "apps/:id/open",
    method: "POST",
    policyKey: "apps/open",
    handler: handleOpenApp,
    summary: "Open an app",
    description:
      "Compile (if needed) and return the app's HTML for rendering.",
    tags: ["apps"],
    responseBody: z.object({
      appId: z.string(),
      dirName: z.string(),
      name: z.string(),
      html: z.string(),
    }),
  },
  {
    operationId: "apps_delete",
    endpoint: "apps/:id/delete",
    method: "POST",
    policyKey: "apps/delete",
    handler: handleDeleteApp,
    summary: "Delete an app",
    description: "Permanently remove an app and its data.",
    tags: ["apps"],
  },
  {
    operationId: "apps_preview_get",
    endpoint: "apps/:id/preview",
    method: "GET",
    policyKey: "apps/preview",
    handler: handleGetPreview,
    summary: "Get app preview",
    description: "Return the preview image or HTML for an app.",
    tags: ["apps"],
  },
  {
    operationId: "apps_preview_update",
    endpoint: "apps/:id/preview",
    method: "PUT",
    policyKey: "apps/preview",
    handler: handleUpdatePreview,
    summary: "Update app preview",
    description: "Set a new preview image or HTML for an app.",
    tags: ["apps"],
    requestBody: z.object({
      preview: z.string().describe("Base64-encoded image or HTML string"),
    }),
  },
  {
    operationId: "apps_history",
    endpoint: "apps/:id/history",
    method: "GET",
    policyKey: "apps/history",
    handler: handleGetHistory,
    summary: "Get app version history",
    description: "Return the git commit history of an app.",
    tags: ["apps"],
    queryParams: [{ name: "limit", type: "number" }],
    responseBody: z.object({
      appId: z.string(),
      versions: z.array(z.unknown()),
    }),
  },
  {
    operationId: "apps_diff",
    endpoint: "apps/:id/diff",
    method: "GET",
    policyKey: "apps/diff",
    handler: handleGetDiff,
    summary: "Get app diff",
    description: "Return a git diff between two commits for an app.",
    tags: ["apps"],
    queryParams: [
      { name: "fromCommit", type: "string", required: true },
      { name: "toCommit", type: "string" },
    ],
  },
  {
    operationId: "apps_restore",
    endpoint: "apps/:id/restore",
    method: "POST",
    policyKey: "apps/restore",
    handler: handleRestore,
    summary: "Restore app version",
    description: "Restore an app to a previous git commit.",
    tags: ["apps"],
    requestBody: z.object({ commitHash: z.string() }),
  },
  {
    operationId: "apps_bundle",
    endpoint: "apps/:id/bundle",
    method: "POST",
    policyKey: "apps/bundle",
    handler: handleBundle,
    summary: "Bundle an app",
    description: "Package an app into a distributable .vbundle archive.",
    tags: ["apps"],
    responseBody: z.object({
      type: z.string(),
      bundlePath: z.string(),
      iconImageBase64: z.string(),
      manifest: z.object({}).passthrough(),
    }),
  },
  {
    operationId: "apps_share_cloud",
    endpoint: "apps/:id/share-cloud",
    method: "POST",
    policyKey: "apps/share-cloud",
    handler: handleShareCloud,
    summary: "Share app to cloud",
    description: "Package and upload an app to the cloud share service.",
    tags: ["apps"],
    responseBody: z.object({
      success: z.boolean(),
      shareToken: z.string(),
      shareUrl: z.string(),
    }),
  },
];
