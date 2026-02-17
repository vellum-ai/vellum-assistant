/**
 * Route handlers for shareable app pages and cloud sharing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { getLogger } from '../../util/logger.js';
import { getApp } from '../../memory/app-store.js';
import * as sharedAppLinksStore from '../../memory/shared-app-links-store.js';
import type { AppManifest } from '../../bundler/manifest.js';

const log = getLogger('runtime-http');

const HTML_ESCAPE_MAP: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  '"': '&quot;',
};

let designSystemCssCache: string | null = null;

function loadDesignSystemCss(): string {
  if (designSystemCssCache !== null) return designSystemCssCache;
  try {
    const cssPath = join(
      import.meta.dirname ?? __dirname,
      '../../../../clients/macos/vellum-assistant/Resources/vellum-design-system.css',
    );
    designSystemCssCache = readFileSync(cssPath, 'utf-8');
  } catch {
    log.warn('Design system CSS not found, pages will render without styles');
    designSystemCssCache = '';
  }
  return designSystemCssCache;
}

export function handleServePage(appId: string): Response {
  const app = getApp(appId);
  if (!app) {
    return Response.json({ error: 'App not found' }, { status: 404 });
  }

  const css = loadDesignSystemCss();
  const escapedName = app.name.replace(/[<>&"]/g, (c) => HTML_ESCAPE_MAP[c] ?? c);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapedName}</title>
  <style>${css}</style>
</head>
<body>
${app.htmlDefinition}
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self' 'unsafe-inline'; img-src * data:; font-src *;",
    },
  });
}

/** 50 MB — generous cap for zip app bundles. */
const MAX_SHARE_BODY_BYTES = 50 * 1024 * 1024;

export async function handleShareApp(req: Request): Promise<Response> {
  const contentLength = Number(req.headers.get('content-length'));
  if (contentLength > MAX_SHARE_BODY_BYTES) {
    return Response.json(
      { error: `Request body too large (limit: ${MAX_SHARE_BODY_BYTES} bytes)` },
      { status: 413 },
    );
  }

  const rawBody = await req.arrayBuffer();
  const bundleData = Buffer.from(rawBody);

  if (bundleData.length === 0) {
    return Response.json({ error: 'Empty body' }, { status: 400 });
  }

  // Validate it's a valid zip with a manifest.json
  let manifest: AppManifest;
  try {
    const zip = await JSZip.loadAsync(bundleData);
    const manifestFile = zip.file('manifest.json');
    if (!manifestFile) {
      return Response.json({ error: 'Invalid bundle: missing manifest.json' }, { status: 400 });
    }
    const manifestText = await manifestFile.async('text');
    manifest = JSON.parse(manifestText) as AppManifest;
    if (!manifest.name || !manifest.entry) {
      return Response.json({ error: 'Invalid manifest: missing required fields' }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof Response) throw err;
    return Response.json({ error: 'Invalid zip file' }, { status: 400 });
  }

  const { shareToken } = sharedAppLinksStore.createSharedAppLink(bundleData, manifest);

  return Response.json({
    shareToken,
    shareUrl: `/v1/apps/shared/${shareToken}`,
    bundleSizeBytes: bundleData.length,
  });
}

export function handleDownloadSharedApp(shareToken: string): Response {
  const record = sharedAppLinksStore.getSharedAppLink(shareToken);
  if (!record) {
    return Response.json({ error: 'Shared app not found' }, { status: 404 });
  }

  sharedAppLinksStore.incrementDownloadCount(shareToken);

  return new Response(new Uint8Array(record.bundleData), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="app.vellumapp"',
    },
  });
}

export function handleGetSharedAppMetadata(shareToken: string): Response {
  const record = sharedAppLinksStore.getSharedAppLink(shareToken);
  if (!record) {
    return Response.json({ error: 'Shared app not found' }, { status: 404 });
  }

  let manifest: AppManifest;
  try {
    manifest = JSON.parse(record.manifestJson) as AppManifest;
  } catch {
    return Response.json({ error: 'Corrupted manifest data' }, { status: 500 });
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
    return Response.json({ error: 'Shared app not found' }, { status: 404 });
  }
  return Response.json({ success: true });
}
