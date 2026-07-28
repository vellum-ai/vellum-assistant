/**
 * Core packaging logic for .vellum zip archives.
 *
 * Reads an app from the app-store, generates a manifest, and produces a
 * zip archive written to a temp file.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";

import { getApp, getAppDirPath } from "../apps/app-store.js";
import { computeContentId } from "../util/content-id.js";
import { getLogger } from "../util/logger.js";
import { APP_VERSION } from "../version.js";
import { compileApp } from "./app-compiler.js";
import type { SigningCallback } from "./bundle-signer.js";
import { signBundle } from "./bundle-signer.js";
import type { AppManifest } from "./manifest.js";
import { serializeManifest } from "./manifest.js";

const bundlerLog = getLogger("app-bundler");

const PACKAGE_VERSION = APP_VERSION;

const MAX_BUNDLE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

export interface BundleResult {
  bundlePath: string;
  manifest: AppManifest;
  /** Base64-encoded PNG of the app icon, if one was generated. */
  iconImageBase64?: string;
}

function generateZipBuffer(zip: JSZip): Promise<Buffer> {
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
}

function isDefaultMainScaffold(source: string): boolean {
  const normalized = source.replace(/\s+/g, " ").trim();
  return (
    normalized.startsWith(
      `import { render } from 'preact'; function App() { return <div>{"Hello, `,
    ) &&
    normalized.endsWith(
      `!"}</div>; } render(<App />, document.getElementById('app')!);`,
    )
  );
}

function assertMultifileSourceReady(
  app: { name: string },
  appDir: string,
): void {
  const srcIndexPath = join(appDir, "src", "index.html");
  const srcMainPath = join(appDir, "src", "main.tsx");
  const missing = [
    !existsSync(srcIndexPath) ? "src/index.html" : null,
    !existsSync(srcMainPath) ? "src/main.tsx" : null,
  ].filter((value): value is string => value !== null);

  if (missing.length > 0) {
    throw new Error(
      `App "${app.name}" is missing ${missing.join(
        " and ",
      )}. Write source files under src/ and call app_refresh before sharing.`,
    );
  }

  const mainSource = readFileSync(srcMainPath, "utf-8");
  if (isDefaultMainScaffold(mainSource)) {
    throw new Error(
      `App "${app.name}" still has the default src/main.tsx scaffold. Write the real multi-file TSX source and call app_refresh before sharing.`,
    );
  }
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

  // Compile the app and bundle the output.
  const compiledFiles: { name: string; data: Buffer }[] = [];

  const appDir = getAppDirPath(appId);

  assertMultifileSourceReady(app, appDir);

  // Compile src/ -> dist/
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
  const distIndexPath = join(distDir, "index.html");
  const distMainPath = join(distDir, "main.js");
  if (!existsSync(distIndexPath) || !existsSync(distMainPath)) {
    throw new Error(
      `Compilation for app "${app.name}" did not produce dist/index.html and dist/main.js. Check src/index.html and src/main.tsx, then call app_refresh.`,
    );
  }
  const indexHtml = await readFile(distIndexPath, "utf-8");
  const mainJs = await readFile(distMainPath);

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

  const zip = new JSZip();

  // Add manifest.json at root level
  zip.file("manifest.json", serializeManifest(manifest));

  // Add compiled dist/ files
  for (const file of compiledFiles) {
    zip.file(file.name, file.data);
  }

  // Include app icon if one was generated
  const iconPath = join(appDir, "icon.png");
  if (existsSync(iconPath)) {
    zip.file("icon.png", readFileSync(iconPath));
  }

  await writeFile(bundlePath, await generateZipBuffer(zip));

  // Sign the bundle if a signing callback is provided
  if (requestSignature) {
    try {
      const signatureJson = await signBundle(bundlePath, requestSignature);

      zip.file("signature.json", JSON.stringify(signatureJson, null, 2));
      await writeFile(bundlePath, await generateZipBuffer(zip));

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
  if (existsSync(iconPath)) {
    iconImageBase64 = readFileSync(iconPath).toString("base64");
  }

  return { bundlePath, manifest, iconImageBase64 };
}
