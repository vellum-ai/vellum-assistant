/**
 * Route handlers for shareable app pages and cloud sharing.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

import JSZip from "jszip";
import { z } from "zod";

import type { AppManifest } from "../../bundler/manifest.js";
import {
  getApp,
  getAppDirPath,
  isMultifileApp,
} from "../../memory/app-store.js";
import {
  createSharedAppLink,
  deleteSharedAppLinkByToken,
  getSharedAppLink,
  incrementDownloadCount,
} from "../../memory/shared-app-links-store.js";
import { getLogger } from "../../util/logger.js";
import { BadRequestError, NotFoundError, RouteError } from "./errors.js";
import type {
  ResponseHeaderArgs,
  RouteDefinition,
  RouteHandlerArgs,
} from "./types.js";

const log = getLogger("runtime-http");

const HTML_ESCAPE_MAP: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  '"': "&quot;",
};

let designSystemCssCache: string | null = null;

function loadDesignSystemCss(): string {
  if (designSystemCssCache != null) return designSystemCssCache;
  try {
    const cssPath = join(
      import.meta.dirname ?? __dirname,
      "../../../../clients/macos/vellum-assistant/Resources/vellum-design-system.css",
    );
    designSystemCssCache = readFileSync(cssPath, "utf-8");
  } catch {
    log.warn("Design system CSS not found, pages will render without styles");
    designSystemCssCache = "";
  }
  return designSystemCssCache;
}

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

function servePageHeaders({ pathParams }: ResponseHeaderArgs): Record<string, string> {
  const appId = pathParams?.appId as string;
  const app = getApp(appId);
  // Multifile apps use external scripts — no 'unsafe-inline' for script-src.
  // Legacy apps contain inline event handlers that require 'unsafe-inline'.
  const scriptSrc = app && isMultifileApp(app)
    ? "'self'"
    : "'self' 'unsafe-inline'";
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": buildCsp(scriptSrc),
  };
}

// ---------------------------------------------------------------------------
// Handlers (return body only)
// ---------------------------------------------------------------------------

function handleServePage({ pathParams }: RouteHandlerArgs): string {
  const appId = pathParams?.appId as string;
  const app = getApp(appId);
  if (!app) {
    throw new NotFoundError("App not found");
  }

  // Multifile apps serve the compiled dist/index.html directly.
  if (isMultifileApp(app)) {
    return serveMultifileApp(appId, app.name);
  }

  const css = loadDesignSystemCss();
  const escapedName = app.name.replace(
    /[<>&"]/g,
    (c) => HTML_ESCAPE_MAP[c] ?? c,
  );

  // Per-response nonce for inline <style> and <script> tags.
  const nonce = randomBytes(16).toString("base64");

  // Inject the nonce into any inline <script> tags from the app HTML definition
  // so they are allowed by the nonce-based CSP without 'unsafe-inline'.
  const noncedHtml = app.htmlDefinition.replace(
    /<script(?=[\s>])/gi,
    `<script nonce="${nonce}"`,
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapedName}</title>
  <style nonce="${nonce}">${css}</style>
</head>
<body>
${noncedHtml}
</body>
</html>`;
}

/**
 * Serve compiled output for multifile TSX apps.
 * Falls back to a "not compiled yet" message if dist/index.html is missing.
 */
function serveMultifileApp(appId: string, appName: string): string {
  const distDir = join(getAppDirPath(appId), "dist");
  const indexPath = join(distDir, "index.html");

  if (!existsSync(indexPath)) {
    const escapedName = appName.replace(
      /[<>&"]/g,
      (c) => HTML_ESCAPE_MAP[c] ?? c,
    );
    return (
      `<!DOCTYPE html><html><head><title>${escapedName}</title></head>` +
      `<body><p>App has not been compiled yet. Edit a source file to trigger a build.</p></body></html>`
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

/** Content-Type map for static dist/ assets. */
const DIST_CONTENT_TYPES: Record<string, string> = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

/**
 * Serve a static file from an app's dist/ directory.
 * Validates the filename to prevent path traversal.
 */
function handleServeDistFile({
  pathParams,
}: RouteHandlerArgs): Uint8Array {
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

  const filePath = join(getAppDirPath(appId), "dist", filename);
  if (!existsSync(filePath)) {
    throw new NotFoundError("File not found");
  }

  return new Uint8Array(readFileSync(filePath));
}

/** 50 MB — generous cap for zip app bundles. */
const MAX_SHARE_BODY_BYTES = 50 * 1024 * 1024;

async function handleShareApp({
  rawBody,
}: RouteHandlerArgs): Promise<{
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

function handleDownloadSharedApp({
  pathParams,
}: RouteHandlerArgs): Uint8Array {
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
    policyKey: "pages",
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
    policyKey: "apps/dist",
    summary: "Serve app dist file",
    description:
      "Serve a static asset from an app's compiled dist/ directory.",
    tags: ["apps"],
    responseHeaders: ({ pathParams }) => ({
      "Content-Type":
        DIST_CONTENT_TYPES[extname(pathParams?.filename ?? "").toLowerCase()] ??
        "application/octet-stream",
      "Cache-Control": "no-cache",
    }),
    handler: handleServeDistFile,
  },
  {
    operationId: "apps_share",
    endpoint: "apps/share",
    method: "POST",
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
    policyKey: "apps/shared/metadata",
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
    policyKey: "apps/shared",
    summary: "Download shared app",
    description: "Download a shared app bundle as a zip file.",
    tags: ["apps"],
    responseHeaders: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="app.vellum"',
    },
    handler: handleDownloadSharedApp,
  },
  {
    operationId: "apps_shared_delete",
    endpoint: "apps/shared/:token",
    method: "DELETE",
    policyKey: "apps/shared",
    summary: "Delete shared app",
    description: "Remove a shared app link.",
    tags: ["apps"],
    responseBody: z.object({
      success: z.boolean(),
    }),
    handler: handleDeleteSharedApp,
  },
];
