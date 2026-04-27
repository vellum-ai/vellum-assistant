/**
 * Route handlers for shareable app pages and cloud sharing.
 *
 * Transport-agnostic handlers (metadata, delete) are exported as ROUTES.
 * HTTP-only handlers (binary downloads, HTML pages, raw body uploads) remain
 * as HTTPRouteDefinitions via appRouteDefinitions().
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
import { httpError } from "../http-errors.js";
import type { HTTPRouteDefinition } from "../http-router.js";
import { NotFoundError, RouteError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("runtime-http");

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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
// Transport-agnostic handlers (shared ROUTES)
// ---------------------------------------------------------------------------

function handleGetSharedAppMetadata({ pathParams }: RouteHandlerArgs) {
  const token = pathParams?.token as string;
  const record = getSharedAppLink(token);
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
  const token = pathParams?.token as string;
  const deleted = deleteSharedAppLinkByToken(token);
  if (!deleted) {
    throw new NotFoundError("Shared app not found");
  }
  return { success: true };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "apps_shared_metadata",
    endpoint: "apps/shared/:token/metadata",
    method: "GET",
    policyKey: "apps/shared/metadata",
    handler: handleGetSharedAppMetadata,
    summary: "Get shared app metadata",
    description: "Return metadata for a shared app bundle.",
    tags: ["apps"],
    responseBody: z.object({
      name: z.string(),
      description: z.string(),
      icon: z.string(),
      bundleSizeBytes: z.number(),
    }),
  },
  {
    operationId: "apps_shared_delete",
    endpoint: "apps/shared/:token",
    method: "DELETE",
    policyKey: "apps/shared",
    handler: handleDeleteSharedApp,
    summary: "Delete shared app",
    description: "Remove a shared app link.",
    tags: ["apps"],
    responseBody: z.object({
      success: z.boolean(),
    }),
  },
];

// ---------------------------------------------------------------------------
// HTTP-only handlers (binary content, raw request body, HTML pages)
// ---------------------------------------------------------------------------

export function handleServePage(appId: string): Response {
  const app = getApp(appId);
  if (!app) {
    return httpError("NOT_FOUND", "App not found", 404);
  }

  if (isMultifileApp(app)) {
    return serveMultifileApp(appId, app.name);
  }

  const css = loadDesignSystemCss();
  const escapedName = app.name.replace(
    /[<>&"]/g,
    (c) => HTML_ESCAPE_MAP[c] ?? c,
  );

  const nonce = randomBytes(16).toString("base64");

  const noncedHtml = app.htmlDefinition.replace(
    /<script(?=[\s>])/gi,
    `<script nonce="${nonce}"`,
  );

  const html = `<!DOCTYPE html>
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

  const csp = [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
    },
  });
}

function serveMultifileApp(appId: string, appName: string): Response {
  const distDir = join(getAppDirPath(appId), "dist");
  const indexPath = join(distDir, "index.html");

  if (!existsSync(indexPath)) {
    const escapedName = appName.replace(
      /[<>&"]/g,
      (c) => HTML_ESCAPE_MAP[c] ?? c,
    );
    return new Response(
      `<!DOCTYPE html><html><head><title>${escapedName}</title></head>` +
        `<body><p>App has not been compiled yet. Edit a source file to trigger a build.</p></body></html>`,
      {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }

  let html = readFileSync(indexPath, "utf-8");
  html = html.replace(
    /(?:src|href)="(\.?\/?main\.(js|css))"/g,
    (_match, _filename, ext) => {
      const attr = ext === "css" ? "href" : "src";
      return `${attr}="/v1/apps/${appId}/dist/main.${ext}"`;
    },
  );

  const csp = [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "img-src 'self' data: https:",
    "font-src 'self' data: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
    },
  });
}

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

export function handleServeDistFile(appId: string, filename: string): Response {
  if (
    !appId ||
    appId.includes("..") ||
    appId.includes("/") ||
    appId.includes("\\") ||
    appId !== appId.trim()
  ) {
    return httpError("BAD_REQUEST", "Invalid appId", 400);
  }

  if (
    !filename ||
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename !== filename.trim()
  ) {
    return httpError("BAD_REQUEST", "Invalid filename", 400);
  }

  const filePath = join(getAppDirPath(appId), "dist", filename);
  if (!existsSync(filePath)) {
    return httpError("NOT_FOUND", "File not found", 404);
  }

  const ext = extname(filename).toLowerCase();
  const contentType = DIST_CONTENT_TYPES[ext] ?? "application/octet-stream";
  const content = readFileSync(filePath);

  return new Response(content, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
    },
  });
}

const MAX_SHARE_BODY_BYTES = 50 * 1024 * 1024;

async function handleShareApp(req: Request): Promise<Response> {
  const rawBody = await req.arrayBuffer();
  if (rawBody.byteLength > MAX_SHARE_BODY_BYTES) {
    return httpError(
      "BAD_REQUEST",
      `Request body too large (limit: ${MAX_SHARE_BODY_BYTES} bytes)`,
      413,
    );
  }

  const bundleData = Buffer.from(rawBody);

  if (bundleData.length === 0) {
    return httpError("BAD_REQUEST", "Empty body", 400);
  }

  let manifest: AppManifest;
  try {
    const zip = await JSZip.loadAsync(bundleData);
    const manifestFile = zip.file("manifest.json");
    if (!manifestFile) {
      return httpError(
        "BAD_REQUEST",
        "Invalid bundle: missing manifest.json",
        400,
      );
    }
    const manifestText = await manifestFile.async("text");
    manifest = JSON.parse(manifestText) as AppManifest;
    if (!manifest.name || !manifest.entry) {
      return httpError(
        "BAD_REQUEST",
        "Invalid manifest: missing required fields",
        400,
      );
    }
  } catch (err) {
    if (err instanceof Response) throw err;
    return httpError("BAD_REQUEST", "Invalid zip file", 400);
  }

  const { shareToken } = createSharedAppLink(bundleData, manifest);

  return Response.json({
    shareToken,
    shareUrl: `/v1/apps/shared/${shareToken}`,
    bundleSizeBytes: bundleData.length,
  });
}

function handleDownloadSharedApp(shareToken: string): Response {
  const record = getSharedAppLink(shareToken);
  if (!record) {
    return httpError("NOT_FOUND", "Shared app not found", 404);
  }

  incrementDownloadCount(shareToken);

  return new Response(new Uint8Array(record.bundleData), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="app.vellum"',
    },
  });
}

// ---------------------------------------------------------------------------
// HTTP-only route definitions (binary/HTML responses, raw request body)
// ---------------------------------------------------------------------------

export function appRouteDefinitions(): HTTPRouteDefinition[] {
  return [
    {
      endpoint: "apps/:appId/dist/:filename",
      method: "GET",
      policyKey: "apps/dist",
      summary: "Serve app dist file",
      description:
        "Serve a static asset from an app's compiled dist/ directory.",
      tags: ["apps"],
      handler: ({ params }) =>
        handleServeDistFile(params.appId, params.filename),
    },
    {
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
      handler: async ({ req }) => handleShareApp(req),
    },
    {
      endpoint: "apps/shared/:token",
      method: "GET",
      policyKey: "apps/shared",
      summary: "Download shared app",
      description: "Download a shared app bundle as a zip file.",
      tags: ["apps"],
      handler: ({ params }) => handleDownloadSharedApp(params.token),
    },
  ];
}
