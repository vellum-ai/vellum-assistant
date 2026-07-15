/**
 * Route handlers for app CRUD, bundling, sharing, versioning,
 * and signing operations.
 */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import {
  type AppDefinition,
  type AppOrigin,
  createApp,
  createAppRecord,
  deleteApp,
  deleteAppRecord,
  type EnumeratedApp,
  getAppDirPath,
  getAppPreview,
  isPluginAppId,
  listApps,
  listAppsByConversation,
  listPluginApps,
  queryAppRecords,
  resolveAppSource,
  resolveEffectiveAppHtmlFromDir,
  updateApp,
  updateAppRecord,
} from "../../apps/app-store.js";
import { createSharedAppLink } from "../../apps/shared-app-links-store.js";
import { packageApp } from "../../bundler/app-bundler.js";
import { compileApp, runCompile } from "../../bundler/app-compiler.js";
import { scanBundle } from "../../bundler/bundle-scanner.js";
import type { SignatureJson } from "../../bundler/bundle-signer.js";
import { verifyBundleSignature } from "../../bundler/signature-verifier.js";
import { compareSemver } from "../../daemon/handlers/shared.js";
import { computeContentId } from "../../util/content-id.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  getOriginClientId,
  publishAppsChanged,
} from "../sync/resource-sync-events.js";
import {
  BadRequestError,
  NotFoundError,
  PayloadTooLargeError,
} from "./errors.js";
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

interface AppListItem {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  createdAt: number;
  updatedAt: number;
  version: string;
  contentId: string;
  /** "workspace" or "plugin:<name>" — identifies where the app comes from. */
  origin: string;
}

function workspaceAppItem(a: AppDefinition): AppListItem {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    icon: a.icon,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    version: a.version ?? "1.0.0",
    contentId: computeContentId(a.name),
    origin: "workspace",
  };
}

function pluginAppItem(app: EnumeratedApp): AppListItem {
  // Plugin apps carry no stored timestamps; use the source dir mtime so the
  // library can still order them sensibly.
  let mtime = 0;
  try {
    mtime = statSync(app.sourcePath).mtimeMs;
  } catch {
    // Directory vanished between enumeration and stat — leave mtime at 0.
  }
  const pluginName =
    app.origin.kind === "plugin" ? app.origin.pluginName : "unknown";
  return {
    id: app.id,
    name: app.name,
    createdAt: mtime,
    updatedAt: mtime,
    version: "1.0.0",
    contentId: computeContentId(app.name),
    origin: `plugin:${pluginName}`,
  };
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

  // Materialize the shared app's compiled output as the fork's dist/ so the
  // fork opens without a source compile (mirrors bundle import).
  const distDir = join(getAppDirPath(newApp.id), "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "index.html"), htmlContent, "utf-8");
  for (const asset of ["main.js", "main.css"]) {
    const assetPath = join(dir, appUuid, asset);
    if (existsSync(assetPath)) {
      writeFileSync(join(distDir, asset), readFileSync(assetPath, "utf-8"));
    }
  }

  return { success: true, appId: newApp.id, name: newApp.name };
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

const MAX_IMPORT_BUNDLE_BYTES = 25 * 1024 * 1024; // 25 MB

async function importBundle(
  rawBody: Uint8Array,
  headers: Record<string, string>,
): Promise<{
  success: true;
  appId: string;
  name: string;
  scanResult: { passed: boolean; blocked: string[]; warnings: string[] };
  signatureResult: {
    trustTier: string;
    signerKeyId?: string;
    signerDisplayName?: string;
    signerAccount?: string;
  };
}> {
  const contentLength = headers["content-length"];
  if (contentLength && Number(contentLength) > MAX_IMPORT_BUNDLE_BYTES) {
    throw new PayloadTooLargeError(
      `Bundle too large (limit: ${MAX_IMPORT_BUNDLE_BYTES / (1024 * 1024)} MB)`,
    );
  }

  // Determine the actual bundle bytes based on content type
  let bundleBytes: Uint8Array;
  const contentType = headers["content-type"] ?? "";
  if (contentType.includes("multipart/form-data")) {
    // Reconstruct a Request to use the platform's multipart parser
    const syntheticReq = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": contentType },
      body: rawBody.buffer as ArrayBuffer,
    });

    let formData: FormData;
    try {
      formData = await syntheticReq.formData();
    } catch {
      throw new BadRequestError("Invalid multipart form data");
    }

    const file = formData.get("file");
    if (!file || !(file instanceof Blob)) {
      throw new BadRequestError(
        'Multipart upload requires a "file" field containing the .vbundle',
      );
    }
    bundleBytes = new Uint8Array(await file.arrayBuffer());
  } else {
    // application/octet-stream or any other content type — use raw body directly
    bundleBytes = rawBody;
  }

  if (bundleBytes.length > MAX_IMPORT_BUNDLE_BYTES) {
    throw new PayloadTooLargeError(
      `Bundle too large (limit: ${MAX_IMPORT_BUNDLE_BYTES / (1024 * 1024)} MB)`,
    );
  }

  // Write to temp file for scanning and signature verification
  const tempPath = join(
    tmpdir(),
    `vellum-import-${randomBytes(8).toString("hex")}.vbundle`,
  );
  writeFileSync(tempPath, bundleBytes);

  try {
    const [scanResult, signatureResult] = await Promise.all([
      scanBundle(tempPath),
      verifyBundleSignature(tempPath).catch(
        (): Awaited<ReturnType<typeof verifyBundleSignature>> => ({
          trustTier: "tampered",
          message: "Signature verification failed — bundle may be tampered",
        }),
      ),
    ]);

    const blocked = scanResult.findings
      .filter((f) => f.level === "block")
      .map((f) => f.message);
    const warnings = scanResult.findings
      .filter((f) => f.level === "warn")
      .map((f) => f.message);

    if (!scanResult.passed) {
      throw new BadRequestError(
        `Bundle blocked by security scan: ${blocked.join("; ")}`,
      );
    }

    // Load the zip and extract contents
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(bundleBytes);

    // Extract manifest
    const manifestFile = zip.file("manifest.json");
    let manifest: {
      name?: string;
      description?: string;
      entry?: string;
      format_version?: number;
    } = {};
    if (manifestFile) {
      const manifestText = await manifestFile.async("text");
      manifest = JSON.parse(manifestText);
    }

    if (manifest.format_version !== 2) {
      throw new BadRequestError(
        "This app bundle uses the legacy single-file format, which is no longer supported. Re-export the app from a current version and try again.",
      );
    }

    const appName = manifest.name ?? "Imported App";
    const appDescription = manifest.description;
    const entry = manifest.entry ?? "index.html";

    // Extract entry HTML
    const entryFile = zip.file(entry);
    if (!entryFile) {
      throw new BadRequestError("Bundle missing entry file");
    }
    const htmlDefinition = await entryFile.async("text");

    // Extract icon if present
    let icon: string | undefined;
    const iconFile = zip.file("icon.png");
    if (iconFile) {
      icon = await iconFile.async("base64");
    }

    // Create the local app
    const newApp = createApp({
      name: appName,
      description: appDescription,
      schemaJson: JSON.stringify({ type: "object", properties: {} }),
      htmlDefinition,
      icon,
    });

    // Extract compiled dist assets (main.js, main.css) into the app's dist/
    // directory so the app can run correctly.
    const appDir = getAppDirPath(newApp.id);
    const distDir = join(appDir, "dist");
    mkdirSync(distDir, { recursive: true });

    // Write dist/index.html
    writeFileSync(join(distDir, "index.html"), htmlDefinition, "utf-8");

    // Write dist/main.js if present in the bundle
    const mainJsFile = zip.file("main.js");
    if (mainJsFile) {
      const mainJs = await mainJsFile.async("text");
      writeFileSync(join(distDir, "main.js"), mainJs, "utf-8");
    }

    // Write dist/main.css if present in the bundle
    const mainCssFile = zip.file("main.css");
    if (mainCssFile) {
      const mainCss = await mainCssFile.async("text");
      writeFileSync(join(distDir, "main.css"), mainCss, "utf-8");
    }

    return {
      success: true,
      appId: newApp.id,
      name: newApp.name,
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
    };
  } finally {
    void unlink(tempPath);
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleListApps({ queryParams }: RouteHandlerArgs) {
  const conversationId = queryParams?.conversationId;
  if (conversationId) {
    // Conversation scoping is a workspace-app concept; plugin apps are not
    // associated with conversations, so they are omitted from this view.
    return {
      apps: listAppsByConversation(conversationId).map(workspaceAppItem),
    };
  }
  const apps: AppListItem[] = [
    ...listApps().map(workspaceAppItem),
    ...listPluginApps().map(pluginAppItem),
  ];
  return { apps };
}

async function handleOpenBundle({ body }: RouteHandlerArgs) {
  if (!body?.filePath) {
    throw new BadRequestError("filePath is required");
  }
  return openBundle(body.filePath as string);
}

async function handleImportBundle({ rawBody, headers }: RouteHandlerArgs) {
  if (!rawBody || rawBody.length === 0) {
    throw new BadRequestError(
      "Request body is required — upload a .vbundle file",
    );
  }
  const result = await importBundle(rawBody, headers ?? {});
  publishAppsChanged(getOriginClientId(headers));
  return result;
}

function handleListSharedApps() {
  return { apps: listSharedApps() };
}

function handleForkSharedApp({ body, headers }: RouteHandlerArgs) {
  if (!body?.uuid) {
    throw new BadRequestError("uuid is required");
  }
  const result = forkSharedApp(body.uuid as string);
  if (!result.success) {
    throw new BadRequestError(result.error);
  }
  publishAppsChanged(getOriginClientId(headers));
  return result;
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
  assertNotPluginApp(appId, "modify a plugin app's data");
  const method = (body?.method as string) ?? "create";
  const result = getAppDataResult(
    method,
    appId,
    body?.recordId as string | undefined,
    body?.data as Record<string, unknown> | undefined,
  );
  return { success: true, result };
}

/**
 * Wire-format provenance tag for an app, matching what `apps_list` reports:
 * `"workspace"` for user-created apps, `"plugin:<name>"` for plugin-bundled
 * ones. Clients read it to hide the mutation actions (delete, share, deploy)
 * the daemon rejects for plugin apps.
 */
function appOriginWire(origin: AppOrigin): string {
  return origin.kind === "plugin" ? `plugin:${origin.pluginName}` : "workspace";
}

/**
 * Compile a multi-file plugin app on open, without touching its `dist/`.
 *
 * A plugin app's real `dist/` is owned by the monitor process
 * (`plugin-source-watch`), which builds it on install and on every source
 * change. But a just-installed app can be opened before the monitor's first
 * pass lands, which would otherwise render the "not compiled yet" fallback.
 * Building in place here would both write into the read-only plugin tree and
 * race the monitor's `rm -rf dist` + write. Instead we compile into a private
 * temp dir and return the self-contained HTML from there, leaving `dist/`
 * ownership solely with the monitor. Returns `null` if the build fails, so the
 * caller falls back to the standard fallback HTML.
 */
async function compilePluginAppHtmlEphemeral(
  appId: string,
  sourceDir: string,
): Promise<string | null> {
  // `resolveAppSource` classifies any app without a root index.html as
  // multi-file, even a malformed one with no src/ (or one whose source was
  // removed before the monitor built dist/). Building that would make the
  // compiler throw, so skip it and let the caller serve the standard fallback
  // rather than surfacing a 500 from a plain open.
  if (!existsSync(join(sourceDir, "src"))) {
    return null;
  }
  const tmpRoot = mkdtempSync(join(tmpdir(), "vellum-plugin-app-"));
  try {
    const result = await runCompile(sourceDir, join(tmpRoot, "dist"));
    if (!result.ok) {
      log.warn(
        { appId, errors: result.errors },
        "Ephemeral compile failed on plugin app open",
      );
      return null;
    }
    // resolveEffectiveAppHtmlFromDir reads `<tmpRoot>/dist/index.html` and
    // inlines its JS/CSS, yielding a self-contained page.
    return resolveEffectiveAppHtmlFromDir(tmpRoot);
  } catch (err) {
    // The compiler reports build failures via `ok: false`; a thrown error is
    // unexpected (e.g. a filesystem fault mid-build) and must still degrade to
    // the fallback instead of a 500.
    log.warn({ appId, err }, "Ephemeral compile threw on plugin app open");
    return null;
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function handleOpenApp({ pathParams }: RouteHandlerArgs) {
  const appId = pathParams?.id as string;
  const source = resolveAppSource(appId);
  if (!source) {
    throw new NotFoundError(`App not found: ${appId}`);
  }

  const result = {
    appId: source.id,
    dirName: source.dirName,
    name: source.name,
    origin: appOriginWire(source.origin),
  };

  // Apps auto-compile on open when their dist/ is missing so a freshly
  // installed app renders immediately instead of the "not compiled yet"
  // fallback.
  if (!existsSync(join(source.sourceDir, "dist", "index.html"))) {
    if (source.origin.kind === "workspace") {
      // Workspace apps own their dist/ and are only compiled in this (daemon)
      // process, so building in place is safe.
      const compiled = await compileApp(source.sourceDir);
      if (!compiled.ok) {
        log.warn(
          { appId, errors: compiled.errors },
          "Auto-compile failed on app open",
        );
      }
    } else {
      // Plugin apps: compile off to the side (see helper) rather than write
      // into the plugin tree or race the monitor.
      const html = await compilePluginAppHtmlEphemeral(appId, source.sourceDir);
      if (html !== null) {
        return { ...result, html };
      }
      // Build failed — fall through to the standard fallback HTML.
    }
  }

  const html = resolveEffectiveAppHtmlFromDir(source.sourceDir);
  return { ...result, html };
}

/**
 * Reject a mutation targeting a plugin-bundled app. Plugin apps are owned by
 * their plugin and are read-only over this surface — their source is not
 * user-editable and their lifecycle is the plugin's.
 */
function assertNotPluginApp(appId: string, action: string): void {
  if (isPluginAppId(appId)) {
    throw new BadRequestError(
      `Plugin-bundled apps are read-only; cannot ${action}. This app is owned by its plugin.`,
    );
  }
}

function handleDeleteApp({ pathParams, headers }: RouteHandlerArgs) {
  const appId = pathParams?.id as string;
  assertNotPluginApp(appId, "delete a plugin app");
  deleteApp(appId);
  publishAppsChanged(getOriginClientId(headers));
  return { success: true };
}

function handleGetPreview({ pathParams }: RouteHandlerArgs) {
  const appId = pathParams?.id as string;
  const preview = getAppPreview(appId);
  return { appId, preview: preview ?? null };
}

function handleUpdatePreview({ pathParams, body }: RouteHandlerArgs) {
  const appId = pathParams?.id as string;
  assertNotPluginApp(appId, "update a plugin app's preview");
  if (!body?.preview) {
    throw new BadRequestError("preview is required");
  }
  updateApp(appId, { preview: body.preview as string });
  return { success: true, appId };
}

async function handleBundle({ pathParams }: RouteHandlerArgs) {
  const appId = pathParams?.id as string;
  assertNotPluginApp(appId, "bundle a plugin app");
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
  assertNotPluginApp(appId, "share a plugin app");
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleListApps,
    summary: "List apps",
    description: "Return all locally installed apps.",
    tags: ["apps"],
    queryParams: [
      {
        name: "conversationId",
        schema: { type: "string" },
        description: "Filter apps by conversation ID",
      },
    ],
    responseBody: z.object({
      apps: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string().optional(),
          icon: z.string().optional(),
          createdAt: z.number(),
          updatedAt: z.number(),
          version: z.string(),
          contentId: z.string(),
          origin: z.string(),
        }),
      ),
    }),
  },
  {
    operationId: "apps_open_bundle",
    endpoint: "apps/open-bundle",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleOpenBundle,
    summary: "Open a .vbundle file",
    description:
      "Scan and validate a .vbundle file from disk and return its manifest.",
    tags: ["apps"],
    requestBody: z.object({
      filePath: z.string().describe("Absolute path to the .vbundle file"),
    }),
    responseBody: z.object({
      manifest: z.object({}).passthrough(),
      scanResult: z.object({
        passed: z.boolean(),
        blocked: z.array(z.string()),
        warnings: z.array(z.string()),
      }),
      signatureResult: z.object({
        trustTier: z.string(),
        signerKeyId: z.string().optional(),
        signerDisplayName: z.string().optional(),
        signerAccount: z.string().optional(),
      }),
      bundleSizeBytes: z.number(),
    }),
  },
  {
    operationId: "apps_shared_list",
    endpoint: "apps/shared",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleListSharedApps,
    summary: "List shared apps",
    description: "Return all apps available via cloud share links.",
    tags: ["apps"],
    responseBody: z.object({
      apps: z.array(
        z.object({
          uuid: z.string(),
          name: z.string(),
          description: z.string().optional(),
          icon: z.string().optional(),
          preview: z.string().optional(),
          entry: z.string(),
          trustTier: z.string(),
          signerDisplayName: z.string().optional(),
          bundleSizeBytes: z.number(),
          installedAt: z.string(),
          version: z.string().optional(),
          contentId: z.string().optional(),
          updateAvailable: z.boolean().optional(),
        }),
      ),
    }),
  },
  {
    operationId: "apps_fork",
    endpoint: "apps/fork",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleForkSharedApp,
    summary: "Fork a shared app",
    description: "Create a local copy of a shared app by its UUID.",
    tags: ["apps"],
    requestBody: z.object({
      uuid: z.string().describe("UUID of the shared app to fork"),
    }),
    responseBody: z.object({
      success: z.literal(true),
      appId: z.string(),
      name: z.string(),
    }),
  },
  {
    operationId: "apps_import_bundle",
    endpoint: "apps/import-bundle",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleImportBundle,
    summary: "Import a .vbundle file",
    description:
      "Upload, validate, and install a .vbundle archive as a new local app.",
    tags: ["apps"],
    requestBody: {
      contentType: "application/octet-stream",
      schema: { type: "string", format: "binary" },
    },
    responseBody: z.object({
      success: z.boolean(),
      appId: z.string(),
      name: z.string(),
      scanResult: z.object({
        passed: z.boolean(),
        blocked: z.array(z.string()),
        warnings: z.array(z.string()),
      }),
      signatureResult: z.object({
        trustTier: z.string(),
        signerKeyId: z.string().optional(),
        signerDisplayName: z.string().optional(),
        signerAccount: z.string().optional(),
      }),
    }),
  },
  {
    operationId: "apps_sign_bundle",
    endpoint: "apps/sign-bundle",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    responseBody: z.object({
      signed: z.boolean().optional(),
      signatureJson: z.object({}).passthrough().optional(),
      payload: z.string().optional(),
      message: z.string().optional(),
    }),
  },
  {
    operationId: "apps_signing_identity",
    endpoint: "apps/signing-identity",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleSigningIdentity,
    summary: "Get signing identity",
    description:
      "Return signing identity info. Signing is managed client-side over HTTP.",
    tags: ["apps"],
    responseBody: z.object({ message: z.string() }),
  },

  // Parameterized `apps/:id/*` routes — must follow all literal routes.

  {
    operationId: "apps_data_query",
    endpoint: "apps/:id/data",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    responseBody: z.object({
      success: z.boolean(),
      result: z.unknown(),
    }),
  },
  {
    operationId: "apps_data_mutate",
    endpoint: "apps/:id/data",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    responseBody: z.object({
      success: z.boolean(),
      result: z.unknown(),
    }),
  },
  {
    operationId: "apps_open",
    endpoint: "apps/:id/open",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleOpenApp,
    summary: "Open an app",
    description: "Compile (if needed) and return the app's HTML for rendering.",
    tags: ["apps"],
    responseBody: z.object({
      appId: z.string(),
      dirName: z.string(),
      name: z.string(),
      html: z.string(),
      origin: z.string(),
    }),
  },
  {
    operationId: "apps_delete",
    endpoint: "apps/:id/delete",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleDeleteApp,
    summary: "Delete an app",
    description: "Permanently remove an app and its data.",
    tags: ["apps"],
    responseBody: z.object({ success: z.boolean() }),
  },
  {
    operationId: "apps_preview_get",
    endpoint: "apps/:id/preview",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleGetPreview,
    summary: "Get app preview",
    description: "Return the preview image or HTML for an app.",
    tags: ["apps"],
    responseBody: z.object({
      appId: z.string(),
      preview: z.string().nullable(),
    }),
  },
  {
    operationId: "apps_preview_update",
    endpoint: "apps/:id/preview",
    method: "PUT",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleUpdatePreview,
    summary: "Update app preview",
    description: "Set a new preview image or HTML for an app.",
    tags: ["apps"],
    requestBody: z.object({
      preview: z.string().describe("Base64-encoded image or HTML string"),
    }),
    responseBody: z.object({
      success: z.boolean(),
      appId: z.string(),
    }),
  },
  {
    operationId: "apps_bundle",
    endpoint: "apps/:id/bundle",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
