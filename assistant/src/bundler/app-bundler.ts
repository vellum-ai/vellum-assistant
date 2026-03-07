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
import { join } from "node:path";

import archiver from "archiver";
import JSZip from "jszip";

import { getApp, getAppsDir } from "../memory/app-store.js";
import { computeContentId } from "../util/content-id.js";
import { getLogger } from "../util/logger.js";
import { compileApp } from "./app-compiler.js";
import type { SigningCallback } from "./bundle-signer.js";
import { signBundle } from "./bundle-signer.js";
import type { AppManifest } from "./manifest.js";
import { serializeManifest } from "./manifest.js";

const bundlerLog = getLogger("app-bundler");

import { APP_VERSION } from "../version.js";
const PACKAGE_VERSION = APP_VERSION;

const MAX_BUNDLE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

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
    format_version: 2,
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

  // Compile the app and bundle the dist/ output.
  const compiledFiles: { name: string; data: Buffer }[] = [];

  const appDir = join(getAppsDir(), appId);
  const compileResult = await compileApp(appDir);
  if (!compileResult.ok) {
    const messages = compileResult.errors
      .map((e) => {
        const loc = e.location
          ? ` (${e.location.file}:${e.location.line}:${e.location.column})`
          : "";
        return `${e.text}${loc}`;
      })
      .join("\n");
    throw new Error(`Compilation failed for app "${app.name}":\n${messages}`);
  }

  const distDir = join(appDir, "dist");
  const indexHtml = await readFile(join(distDir, "index.html"), "utf-8");
  const mainJs = await readFile(join(distDir, "main.js"));

  compiledFiles.push({ name: "index.html", data: Buffer.from(indexHtml) });
  compiledFiles.push({ name: "main.js", data: mainJs });

  // main.css is optional — only produced when the app imports CSS
  const cssPath = join(distDir, "main.css");
  if (existsSync(cssPath)) {
    compiledFiles.push({ name: "main.css", data: await readFile(cssPath) });
  }

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

    // Add compiled dist/ files
    for (const file of compiledFiles) {
      archive.append(file.data, { name: file.name });
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
