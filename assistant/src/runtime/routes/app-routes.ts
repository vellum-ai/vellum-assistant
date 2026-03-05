/**
 * Route handlers for shareable app pages and cloud sharing.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import JSZip from "jszip";

import type { AppManifest } from "../../bundler/manifest.js";
import { getApp } from "../../memory/app-store.js";
import * as sharedAppLinksStore from "../../memory/shared-app-links-store.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

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

export function handleServePage(appId: string): Response {
  const app = getApp(appId);
  if (!app) {
    return httpError("NOT_FOUND", "App not found", 404);
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

  // App HTML is user- or LLM-generated and commonly contains inline event
  // handlers (onclick, onkeydown, etc.). Nonce-only script-src blocks those
  // because CSP nonces only authorize <script> blocks, not handler attributes.
  // We keep 'unsafe-inline' so arbitrary app content works.
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

/** 50 MB — generous cap for zip app bundles. */
const MAX_SHARE_BODY_BYTES = 50 * 1024 * 1024;

export async function handleShareApp(req: Request): Promise<Response> {
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

  // Validate it's a valid zip with a manifest.json
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

  const { shareToken } = sharedAppLinksStore.createSharedAppLink(
    bundleData,
    manifest,
  );

  return Response.json({
    shareToken,
    shareUrl: `/v1/apps/shared/${shareToken}`,
    bundleSizeBytes: bundleData.length,
  });
}

export function handleDownloadSharedApp(shareToken: string): Response {
  const record = sharedAppLinksStore.getSharedAppLink(shareToken);
  if (!record) {
    return httpError("NOT_FOUND", "Shared app not found", 404);
  }

  sharedAppLinksStore.incrementDownloadCount(shareToken);

  return new Response(new Uint8Array(record.bundleData), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="app.vellum"',
    },
  });
}

export function handleGetSharedAppMetadata(shareToken: string): Response {
  const record = sharedAppLinksStore.getSharedAppLink(shareToken);
  if (!record) {
    return httpError("NOT_FOUND", "Shared app not found", 404);
  }

  let manifest: AppManifest;
  try {
    manifest = JSON.parse(record.manifestJson) as AppManifest;
  } catch {
    return httpError("INTERNAL_ERROR", "Corrupted manifest data", 500);
  }

  return Response.json({
    name: manifest.name,
    description: manifest.description,
    icon: manifest.icon,
    bundleSizeBytes: record.bundleSizeBytes,
  });
}

export function handleDeleteSharedApp(shareToken: string): Response {
  const deleted = sharedAppLinksStore.deleteSharedAppLinkByToken(shareToken);
  if (!deleted) {
    return httpError("NOT_FOUND", "Shared app not found", 404);
  }
  return Response.json({ success: true });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function appRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "apps/share",
      method: "POST",
      handler: async ({ req }) => handleShareApp(req),
    },
    {
      endpoint: "apps/shared/:token/metadata",
      method: "GET",
      policyKey: "apps/shared/metadata",
      handler: ({ params }) => handleGetSharedAppMetadata(params.token),
    },
    {
      endpoint: "apps/shared/:token",
      method: "GET",
      policyKey: "apps/shared",
      handler: ({ params }) => handleDownloadSharedApp(params.token),
    },
    {
      endpoint: "apps/shared/:token",
      method: "DELETE",
      policyKey: "apps/shared",
      handler: ({ params }) => handleDeleteSharedApp(params.token),
    },
  ];
}
