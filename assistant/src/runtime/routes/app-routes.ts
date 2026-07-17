/**
 * Route handlers for shareable app pages and cloud sharing.
 */
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

import JSZip from "jszip";
import { z } from "zod";

import {
  isLegacySingleFileDir,
  readAppFileBytesFromDir,
  resolveAppSource,
  UNSUPPORTED_LEGACY_APP_HTML,
} from "../../apps/app-store.js";
import {
  createSharedAppLink,
  deleteSharedAppLinkByToken,
  getSharedAppLink,
  incrementDownloadCount,
} from "../../apps/shared-app-links-store.js";
import type { AppManifest } from "../../bundler/manifest.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError, RouteError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const HTML_ESCAPE_MAP: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  '"': "&quot;",
};

// ---------------------------------------------------------------------------
// CSP helpers (shared between handlers and responseHeaders)
// ---------------------------------------------------------------------------

function buildCsp(scriptSrc: string): string {
  return [
    "default-src 'self'",
    `style-src 'self' 'unsafe-inline'`,
    `script-src ${scriptSrc}`,
    "img-src 'self' data: https:",
    "font-src 'self' data: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
}

function servePageHeaders(): Record<string, string> {
  // Apps load external compiled scripts only — no 'unsafe-inline' for
  // script-src.
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": buildCsp("'self'"),
  };
}

// ---------------------------------------------------------------------------
// Handlers (return body only)
// ---------------------------------------------------------------------------

function handleServePage({ pathParams }: RouteHandlerArgs): string {
  const appId = pathParams?.appId as string;
  const source = resolveAppSource(appId);
  if (!source) {
    throw new NotFoundError("App not found");
  }

  return serveCompiledApp(source.id, source.sourceDir, source.name);
}

/**
 * Serve an app's compiled dist/ output. Falls back to a "not compiled yet"
 * message if dist/index.html is missing, or an "unsupported format" message
 * for apps in the retired single-file HTML format.
 */
function serveCompiledApp(
  appId: string,
  appDir: string,
  appName: string,
): string {
  const distDir = join(appDir, "dist");
  const indexPath = join(distDir, "index.html");

  if (!existsSync(indexPath)) {
    const escapedName = appName.replace(
      /[<>&"]/g,
      (c) => HTML_ESCAPE_MAP[c] ?? c,
    );
    const body = isLegacySingleFileDir(appDir)
      ? UNSUPPORTED_LEGACY_APP_HTML
      : `<p>App has not been compiled yet. Edit a source file to trigger a build.</p>`;
    return (
      `<!DOCTYPE html><html><head><title>${escapedName}</title></head>` +
      `<body>${body}</body></html>`
    );
  }

  // Rewrite relative asset paths to absolute HTTP routes so browsers and
  // HTTP-based consumers (e.g. /pages/:appId) can resolve them. The macOS
  // WebView uses the vellumapp:// scheme handler which resolves on disk,
  // but HTTP clients need the /v1/apps/:appId/dist/ route.
  let html = readFileSync(indexPath, "utf-8");
  html = html.replace(
    /(?:src|href)="(\.?\/?main\.(js|css))"/g,
    (_match, _filename, ext) => {
      const attr = ext === "css" ? "href" : "src";
      return `${attr}="/v1/apps/${appId}/dist/main.${ext}"`;
    },
  );

  return html;
}

/** Content-Type map for static app files (dist/ assets and bundled media). */
const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".oga": "audio/ogg",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

function contentTypeForPath(filePath: string): string {
  return (
    STATIC_CONTENT_TYPES[extname(filePath).toLowerCase()] ??
    "application/octet-stream"
  );
}

/**
 * Serve a static file from an app's dist/ directory.
 * Validates the filename to prevent path traversal.
 */
function handleServeDistFile({ pathParams }: RouteHandlerArgs): Uint8Array {
  const appId = pathParams?.appId as string;
  const filename = pathParams?.filename as string;

  // Reject any traversal attempts on appId
  if (
    !appId ||
    appId.includes("..") ||
    appId.includes("/") ||
    appId.includes("\\") ||
    appId !== appId.trim()
  ) {
    throw new BadRequestError("Invalid appId");
  }

  // Reject any traversal attempts on filename
  if (
    !filename ||
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename !== filename.trim()
  ) {
    throw new BadRequestError("Invalid filename");
  }

  const source = resolveAppSource(appId);
  if (!source) {
    throw new NotFoundError("App not found");
  }

  const filePath = join(source.sourceDir, "dist", filename);
  if (!existsSync(filePath)) {
    throw new NotFoundError("File not found");
  }

  return new Uint8Array(readFileSync(filePath));
}

/** 25 MB — generous cap for a single bundled app asset. */
const MAX_APP_ASSET_BYTES = 25 * 1024 * 1024;

/**
 * Serve a bundled file from anywhere in an app's directory (e.g.
 * `assets/intro.mp4`), for binary media an app can't practically inline as a
 * data-URI. `readAppFileBytesFromDir` runs the app-store path validation
 * (rejects `..`, absolute paths, symlink escapes, and the protected
 * `records/` directory), so authors bundle assets under the app dir and load
 * them via `window.vellum.asset(path)`.
 */
function handleServeAppAsset({ pathParams }: RouteHandlerArgs): Uint8Array {
  const appId = pathParams?.appId as string;
  const assetPath = pathParams?.path as string;

  if (
    !appId ||
    appId.includes("..") ||
    appId.includes("/") ||
    appId.includes("\\") ||
    appId !== appId.trim()
  ) {
    throw new BadRequestError("Invalid appId");
  }
  if (!assetPath || assetPath.trim() === "") {
    throw new BadRequestError("Invalid asset path");
  }

  const source = resolveAppSource(appId);
  if (!source) {
    throw new NotFoundError("Asset not found");
  }

  let bytes: Buffer;
  try {
    bytes = readAppFileBytesFromDir(source.sourceDir, assetPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("not found")) {
      throw new NotFoundError("Asset not found");
    }
    // validateFilePath throws on traversal / absolute / records-dir access.
    throw new BadRequestError("Invalid asset path");
  }

  if (bytes.byteLength > MAX_APP_ASSET_BYTES) {
    throw new BadRequestError(
      `Asset too large (limit: ${MAX_APP_ASSET_BYTES} bytes)`,
    );
  }

  return new Uint8Array(bytes);
}

/** 50 MB — generous cap for zip app bundles. */
const MAX_SHARE_BODY_BYTES = 50 * 1024 * 1024;

async function handleShareApp({ rawBody }: RouteHandlerArgs): Promise<{
  shareToken: string;
  shareUrl: string;
  bundleSizeBytes: number;
}> {
  if (!rawBody) {
    throw new BadRequestError("Expected binary body");
  }

  if (rawBody.byteLength > MAX_SHARE_BODY_BYTES) {
    throw new BadRequestError(
      `Request body too large (limit: ${MAX_SHARE_BODY_BYTES} bytes)`,
    );
  }

  const bundleData = Buffer.from(rawBody);

  if (bundleData.length === 0) {
    throw new BadRequestError("Empty body");
  }

  // Validate it's a valid zip with a manifest.json
  let manifest: AppManifest;
  try {
    const zip = await JSZip.loadAsync(bundleData);
    const manifestFile = zip.file("manifest.json");
    if (!manifestFile) {
      throw new BadRequestError("Invalid bundle: missing manifest.json");
    }
    const manifestText = await manifestFile.async("text");
    manifest = JSON.parse(manifestText) as AppManifest;
    if (!manifest.name || !manifest.entry) {
      throw new BadRequestError("Invalid manifest: missing required fields");
    }
  } catch (err) {
    if (err instanceof RouteError) throw err;
    throw new BadRequestError("Invalid zip file");
  }

  const { shareToken } = createSharedAppLink(bundleData, manifest);

  return {
    shareToken,
    shareUrl: `/v1/apps/shared/${shareToken}`,
    bundleSizeBytes: bundleData.length,
  };
}

function handleDownloadSharedApp({ pathParams }: RouteHandlerArgs): Uint8Array {
  const shareToken = pathParams?.token as string;
  const record = getSharedAppLink(shareToken);
  if (!record) {
    throw new NotFoundError("Shared app not found");
  }

  incrementDownloadCount(shareToken);

  return new Uint8Array(record.bundleData);
}

function handleGetSharedAppMetadata({ pathParams }: RouteHandlerArgs) {
  const shareToken = pathParams?.token as string;
  const record = getSharedAppLink(shareToken);
  if (!record) {
    throw new NotFoundError("Shared app not found");
  }

  let manifest: AppManifest;
  try {
    manifest = JSON.parse(record.manifestJson) as AppManifest;
  } catch {
    throw new RouteError("Corrupted manifest data", "INTERNAL_ERROR", 500);
  }

  return {
    name: manifest.name,
    description: manifest.description,
    icon: manifest.icon,
    bundleSizeBytes: record.bundleSizeBytes,
  };
}

function handleDeleteSharedApp({ pathParams }: RouteHandlerArgs) {
  const shareToken = pathParams?.token as string;
  const deleted = deleteSharedAppLinkByToken(shareToken);
  if (!deleted) {
    throw new NotFoundError("Shared app not found");
  }
  return { success: true };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "pages_serve",
    endpoint: "pages/:appId",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Serve app page",
    description: "Render and serve a shareable app page as HTML.",
    tags: ["apps"],
    responseHeaders: servePageHeaders,
    handler: handleServePage,
  },
  {
    operationId: "apps_dist_file",
    endpoint: "apps/:appId/dist/:filename",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Serve app dist file",
    description: "Serve a static asset from an app's compiled dist/ directory.",
    tags: ["apps"],
    responseHeaders: ({ pathParams }) => ({
      "Content-Type": contentTypeForPath(pathParams?.filename ?? ""),
      "Cache-Control": "no-cache",
    }),
    handler: handleServeDistFile,
  },
  {
    operationId: "apps_asset",
    endpoint: "apps/:appId/asset/:path*",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Serve app asset",
    description:
      "Serve a bundled binary asset (image, audio, video, font) from anywhere in an app's directory.",
    tags: ["apps"],
    responseHeaders: ({ pathParams }) => ({
      "Content-Type": contentTypeForPath(pathParams?.path ?? ""),
      "Cache-Control": "no-cache",
    }),
    handler: handleServeAppAsset,
  },
  {
    operationId: "apps_share",
    endpoint: "apps/share",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Share an app",
    description: "Upload a zip app bundle and create a shareable link.",
    tags: ["apps"],
    responseBody: z.object({
      shareToken: z.string(),
      shareUrl: z.string(),
      bundleSizeBytes: z.number(),
    }),
    handler: handleShareApp,
  },
  {
    operationId: "apps_shared_metadata",
    endpoint: "apps/shared/:token/metadata",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get shared app metadata",
    description: "Return metadata for a shared app bundle.",
    tags: ["apps"],
    responseBody: z.object({
      name: z.string(),
      description: z.string(),
      icon: z.string(),
      bundleSizeBytes: z.number(),
    }),
    handler: handleGetSharedAppMetadata,
  },
  {
    operationId: "apps_shared_download",
    endpoint: "apps/shared/:token",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Download shared app",
    description: "Download a shared app bundle as a zip file.",
    tags: ["apps"],
    responseHeaders: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="app.vellum"',
    },
    responseBody: {
      contentType: "application/zip",
      schema: { type: "string", format: "binary" },
    },
    handler: handleDownloadSharedApp,
  },
  {
    operationId: "apps_shared_delete",
    endpoint: "apps/shared/:token",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Delete shared app",
    description: "Remove a shared app link.",
    tags: ["apps"],
    responseBody: z.object({
      success: z.boolean(),
    }),
    handler: handleDeleteSharedApp,
  },
];
