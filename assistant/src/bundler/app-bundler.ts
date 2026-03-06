/**
 * Core packaging logic for .vellum zip archives.
 *
 * Reads an app from the app-store, generates a manifest, and produces a
 * zip archive written to a temp file.
 */

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import archiver from "archiver";
import JSZip from "jszip";

import { getApp, getAppsDir } from "../memory/app-store.js";
import { computeContentId } from "../util/content-id.js";
import { getLogger } from "../util/logger.js";
import type { SigningCallback } from "./bundle-signer.js";
import { signBundle } from "./bundle-signer.js";
import type { AppManifest } from "./manifest.js";
import { serializeManifest } from "./manifest.js";

const bundlerLog = getLogger("app-bundler");

import { APP_VERSION } from "../version.js";
const PACKAGE_VERSION = APP_VERSION;

const HASH_DISPLAY_LENGTH = 12;
const MAX_BUNDLE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB
const ASSET_FETCH_TIMEOUT_MS = 10_000;

interface FetchedAsset {
  archivePath: string; // e.g. "assets/a1b2c3d4.png"
  data: Buffer;
}

/**
 * Extract all remote (http/https) URLs from HTML content.
 * Looks in src=, href= on all elements except <a> tags, and CSS url() references.
 */
export function extractRemoteUrls(html: string): string[] {
  const urls = new Set<string>();

  // Match src="..." attributes on any element
  const srcRe = /\bsrc\s*=\s*(?:"([^"]*?)"|'([^']*?)'|([^\s>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = srcRe.exec(html)) != null) {
    const url = m[1] ?? m[2] ?? m[3];
    if (url && /^https?:\/\//i.test(url)) {
      urls.add(url);
    }
  }

  // Match href="..." on any element except navigation/resolution tags (not assets).
  // Captures the tag name and href value so we can skip them.
  const hrefRe =
    /<(\w+)\b[^>]*?\bhref\s*=\s*(?:"([^"]*?)"|'([^']*?)'|([^\s>]+))[^>]*?\/?>/gi;
  while ((m = hrefRe.exec(html)) != null) {
    const tagName = m[1];
    if (["a", "base", "area"].includes(tagName.toLowerCase())) continue;
    const url = m[2] ?? m[3] ?? m[4];
    if (url && /^https?:\/\//i.test(url)) {
      urls.add(url);
    }
  }

  // Match CSS url() references (inline styles and <style> blocks)
  const urlRe = /url\(\s*(?:"([^"]*?)"|'([^']*?)'|([^)"'\s]+))\s*\)/gi;
  while ((m = urlRe.exec(html)) != null) {
    const url = m[1] ?? m[2] ?? m[3];
    if (url && /^https?:\/\//i.test(url)) {
      urls.add(url);
    }
  }

  return [...urls];
}

/**
 * Derive a deterministic filename for a remote asset URL.
 * Uses a hash of the URL to avoid collisions, preserving the original extension.
 */
function assetFilename(url: string): string {
  const hash = createHash("sha256")
    .update(url)
    .digest("hex")
    .slice(0, HASH_DISPLAY_LENGTH);
  let ext = "";
  try {
    const parsed = new URL(url);
    ext = extname(parsed.pathname);
  } catch {
    // no extension
  }
  // Fallback: if no extension or it's too long/weird, drop it
  if (!ext || ext.length > 10 || !/^\.\w+$/.test(ext)) {
    ext = "";
  }
  return `${hash}${ext}`;
}

/**
 * Fetch remote assets referenced in HTML, returning the fetched buffers
 * and the rewritten HTML with local asset paths. Assets that fail to fetch
 * are left with their original URLs.
 */
export async function materializeAssets(
  html: string,
): Promise<{ rewrittenHtml: string; assets: FetchedAsset[] }> {
  const urls = extractRemoteUrls(html);
  if (urls.length === 0) {
    return { rewrittenHtml: html, assets: [] };
  }

  const assets: FetchedAsset[] = [];
  // Map from original URL to its local archive path
  const urlMap = new Map<string, string>();

  await Promise.all(
    urls.map(async (url) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          ASSET_FETCH_TIMEOUT_MS,
        );
        let buf: Buffer;
        try {
          const resp = await fetch(url, { signal: controller.signal });
          if (!resp.ok) {
            bundlerLog.warn(
              { url, status: resp.status },
              "Failed to fetch asset, keeping original URL",
            );
            return;
          }
          buf = Buffer.from(await resp.arrayBuffer());
        } finally {
          clearTimeout(timeout);
        }
        const filename = assetFilename(url);
        const archivePath = `assets/${filename}`;
        assets.push({ archivePath, data: buf });
        urlMap.set(url, archivePath);
      } catch (err) {
        bundlerLog.warn(
          { url, err },
          "Failed to fetch asset, keeping original URL",
        );
      }
    }),
  );

  // Rewrite URLs in HTML — replace each occurrence of the original URL with the local path.
  // Sort by length descending so longer URLs are replaced first, preventing prefix collisions
  // (e.g. "https://cdn/x" replacing part of "https://cdn/x/y.png").
  const sortedEntries = [...urlMap.entries()].sort(
    (a, b) => b[0].length - a[0].length,
  );
  let rewrittenHtml = html;
  for (const [originalUrl, localPath] of sortedEntries) {
    // Escape regex special chars in the URL
    const escaped = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    rewrittenHtml = rewrittenHtml.replace(new RegExp(escaped, "g"), localPath);
  }

  return { rewrittenHtml, assets };
}

export interface BundleResult {
  bundlePath: string;
  manifest: AppManifest;
  /** Base64-encoded PNG of the app icon, if one was generated. */
  iconImageBase64?: string;
}

/**
 * Package an app into a .vellum zip archive.
 *
 * @param appId - The ID of the app to package (from the app-store).
 * @param requestSignature - Optional callback to request an Ed25519 signature from the Swift client.
 *                           If provided, the bundle will be signed and include a signature.json.
 * @returns The path to the created .vellum file and the manifest.
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
  const createdBy = `vellum-assistant/${PACKAGE_VERSION}`;
  const version = app.version ?? "1.0.0";
  const contentId = computeContentId(app.name);

  const manifest: AppManifest = {
    format_version: 1,
    name: app.name,
    ...(app.description ? { description: app.description } : {}),
    ...(app.icon ? { icon: app.icon } : {}),
    ...(app.preview ? { preview: app.preview } : {}),
    created_at: new Date().toISOString(),
    created_by: createdBy,
    entry: "index.html",
    capabilities: [],
    version,
    content_id: contentId,
  };

  // Fetch remote assets and rewrite HTML to reference local copies
  const { rewrittenHtml, assets: fetchedAssets } = await materializeAssets(
    app.htmlDefinition,
  );

  // Also materialize assets in additional pages
  const rewrittenPages: Record<string, string> = {};
  const pageAssets: FetchedAsset[] = [];
  if (app.pages) {
    for (const [filename, content] of Object.entries(app.pages)) {
      const result = await materializeAssets(content);
      rewrittenPages[filename] = result.rewrittenHtml;
      pageAssets.push(...result.assets);
    }
  }

  // Deduplicate assets by archive path
  const allAssetsMap = new Map<string, FetchedAsset>();
  for (const asset of [...fetchedAssets, ...pageAssets]) {
    allAssetsMap.set(asset.archivePath, asset);
  }
  const allAssets = [...allAssetsMap.values()];

  // Create the zip archive
  const safeName = app.name.replace(/[/\\:*?"<>|]/g, "_").trim() || "App";
  const uniqueSuffix = createHash("sha256")
    .update(`${appId}-${Date.now()}`)
    .digest("hex")
    .slice(0, 8);
  const bundleFilename = `${safeName}-${uniqueSuffix}.vellum`;
  const bundlePath = join(tmpdir(), bundleFilename);

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(bundlePath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve());
    output.on("error", (err: Error) => reject(err));
    archive.on("error", (err: Error) => reject(err));
    archive.on("warning", (err: Error) => {
      // Only reject on fatal warnings
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        reject(err);
      }
    });

    archive.pipe(output);

    // Add manifest.json at root level
    archive.append(serializeManifest(manifest), { name: "manifest.json" });

    // Add index.html at root level
    archive.append(rewrittenHtml, { name: "index.html" });

    // Add additional pages alongside index.html (with rewritten asset URLs)
    if (app.pages) {
      for (const filename of Object.keys(app.pages)) {
        const content = rewrittenPages[filename] ?? app.pages[filename];
        archive.append(content, { name: filename });
      }
    }

    // Add fetched remote assets
    for (const asset of allAssets) {
      archive.append(asset.data, { name: asset.archivePath });
    }

    // Include app icon if one was generated
    const iconPath = join(getAppsDir(), appId, "icon.png");
    if (existsSync(iconPath)) {
      archive.append(readFileSync(iconPath), { name: "icon.png" });
    }

    archive.finalize();
  });

  // Sign the bundle if a signing callback is provided
  if (requestSignature) {
    try {
      const signatureJson = await signBundle(bundlePath, requestSignature);

      // Re-open the zip and add signature.json
      const zipBuffer = await readFile(bundlePath);
      const zip = await JSZip.loadAsync(zipBuffer);
      zip.file("signature.json", JSON.stringify(signatureJson, null, 2));
      const signedBuffer = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 9 },
      });
      await writeFile(bundlePath, signedBuffer);

      bundlerLog.info({ appId }, "Bundle signed successfully");
    } catch (err) {
      bundlerLog.warn(
        { err, appId },
        "Failed to sign bundle, proceeding unsigned",
      );
    }
  }

  // Enforce size limit
  const stats = await stat(bundlePath);
  if (stats.size > MAX_BUNDLE_SIZE_BYTES) {
    // Clean up the oversized file
    const { unlink } = await import("node:fs/promises");
    await unlink(bundlePath);
    throw new Error(
      `Bundle size ${(stats.size / 1024 / 1024).toFixed(
        1,
      )} MB exceeds the maximum allowed size of 25 MB`,
    );
  }

  // Read icon for inclusion in the response
  let iconImageBase64: string | undefined;
  const iconFilePath = join(getAppsDir(), appId, "icon.png");
  if (existsSync(iconFilePath)) {
    iconImageBase64 = readFileSync(iconFilePath).toString("base64");
  }

  return { bundlePath, manifest, iconImageBase64 };
}
