/**
 * Core packaging logic for .vellumapp zip archives.
 *
 * Reads an app from the app-store, generates a manifest, rewrites asset
 * references in the HTML, and produces a zip archive written to a temp file.
 */

import { createWriteStream } from 'node:fs';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import archiver from 'archiver';
import JSZip from 'jszip';
import { getApp } from '../memory/app-store.js';
import type { AppManifest } from './manifest.js';
import { serializeManifest } from './manifest.js';
import { signBundle } from './bundle-signer.js';
import type { SigningCallback } from './bundle-signer.js';
import { getLogger } from '../util/logger.js';

const bundlerLog = getLogger('app-bundler');

/** Read the package version at import time. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const packageJson = require('../../package.json') as { version: string };
const PACKAGE_VERSION = packageJson.version;

const MAX_BUNDLE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

export interface BundleResult {
  bundlePath: string;
  manifest: AppManifest;
}

/**
 * Scan HTML for `<img src="...">` references that use absolute or blob URLs.
 * Returns a map from original URL to relative asset path (e.g. `assets/0.png`).
 */
function extractAssetReferences(html: string): Map<string, string> {
  const refs = new Map<string, string>();
  // Match src attributes in img tags — handles both single and double quotes
  const imgSrcRegex = /<img\s[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = imgSrcRegex.exec(html)) !== null) {
    const url = match[1];
    // Only rewrite absolute URLs (http/https) and blob URLs
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('blob:')) {
      if (!refs.has(url)) {
        // Derive a simple extension from the URL if possible
        const ext = guessExtension(url);
        refs.set(url, `assets/${index}${ext}`);
        index++;
      }
    }
  }

  return refs;
}

/**
 * Guess a file extension from a URL. Returns `.png` as a fallback.
 */
function guessExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const dotIndex = pathname.lastIndexOf('.');
    if (dotIndex !== -1) {
      const ext = pathname.slice(dotIndex).toLowerCase();
      // Only allow common image extensions
      if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'].includes(ext)) {
        return ext;
      }
    }
  } catch {
    // blob: URLs or invalid URLs — fall through
  }
  return '.png';
}

/**
 * Rewrite asset references in HTML from absolute/blob URLs to relative paths.
 */
function rewriteAssetReferences(html: string, refs: Map<string, string>): string {
  let result = html;
  for (const [originalUrl, relativePath] of refs) {
    // Replace all occurrences of the original URL with the relative path
    result = result.split(originalUrl).join(relativePath);
  }
  return result;
}

/**
 * Package an app into a .vellumapp zip archive.
 *
 * @param appId - The ID of the app to package (from the app-store).
 * @param requestSignature - Optional callback to request an Ed25519 signature from the Swift client.
 *                           If provided, the bundle will be signed and include a signature.json.
 * @returns The path to the created .vellumapp file and the manifest.
 * @throws If the app is not found, or the bundle exceeds the size limit.
 */
export async function packageApp(
  appId: string,
  requestSignature?: SigningCallback,
): Promise<BundleResult> {
  const app = getApp(appId);
  if (!app) {
    throw new Error(`App not found: ${appId}`);
  }

  // Build manifest
  const manifest: AppManifest = {
    format_version: 1,
    name: app.name,
    ...(app.description ? { description: app.description } : {}),
    created_at: new Date().toISOString(),
    created_by: `vellum-assistant/${PACKAGE_VERSION}`,
    entry: 'index.html',
    capabilities: [],
  };

  // Extract and rewrite asset references in the HTML
  const assetRefs = extractAssetReferences(app.htmlDefinition);
  const rewrittenHtml = rewriteAssetReferences(app.htmlDefinition, assetRefs);

  // Create the zip archive
  const bundleFilename = `${app.name.replace(/[^a-zA-Z0-9_-]/g, '_')}-${randomUUID().slice(0, 8)}.vellumapp`;
  const bundlePath = join(tmpdir(), bundleFilename);

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(bundlePath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve());
    archive.on('error', (err: Error) => reject(err));
    archive.on('warning', (err: Error) => {
      // Only reject on fatal warnings
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        reject(err);
      }
    });

    archive.pipe(output);

    // Add manifest.json at root level
    archive.append(serializeManifest(manifest), { name: 'manifest.json' });

    // Add index.html at root level
    archive.append(rewrittenHtml, { name: 'index.html' });

    // For MVP, we don't fetch remote assets — we just rewrite the URLs.
    // The assets/ directory entries are placeholders for future asset downloading.
    // If there were local asset buffers, we'd add them here:
    // archive.append(buffer, { name: relativePath });

    archive.finalize();
  });

  // Sign the bundle if a signing callback is provided
  if (requestSignature) {
    try {
      const signatureJson = await signBundle(bundlePath, requestSignature);

      // Re-open the zip and add signature.json
      const zipBuffer = await readFile(bundlePath);
      const zip = await JSZip.loadAsync(zipBuffer);
      zip.file('signature.json', JSON.stringify(signatureJson, null, 2));
      const signedBuffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
      });
      await writeFile(bundlePath, signedBuffer);

      bundlerLog.info({ appId }, 'Bundle signed successfully');
    } catch (err) {
      bundlerLog.warn({ err, appId }, 'Failed to sign bundle, proceeding unsigned');
    }
  }

  // Enforce size limit
  const stats = await stat(bundlePath);
  if (stats.size > MAX_BUNDLE_SIZE_BYTES) {
    // Clean up the oversized file
    const { unlink } = await import('node:fs/promises');
    await unlink(bundlePath);
    throw new Error(
      `Bundle size ${(stats.size / 1024 / 1024).toFixed(1)} MB exceeds the maximum allowed size of 25 MB`,
    );
  }

  return { bundlePath, manifest };
}
