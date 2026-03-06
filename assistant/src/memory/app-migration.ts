/**
 * One-way migration helper: converts legacy single-HTML apps to the
 * multi-file src/ layout (formatVersion 2).
 *
 * Non-destructive — the root index.html is preserved as a legacy fallback.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getApp, getAppsDir, isMultifileApp } from "./app-store.js";

export interface MigrationResult {
  ok: boolean;
  error?: string;
}

/**
 * Extract inline `<style>` blocks from HTML, returning the extracted CSS
 * and the HTML with those blocks replaced by a `<link>` tag.
 */
function extractInlineStyles(html: string): {
  css: string;
  html: string;
} {
  const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  const cssChunks: string[] = [];

  for (const match of html.matchAll(styleRegex)) {
    cssChunks.push(match[1].trim());
  }

  if (cssChunks.length === 0) {
    return { css: "", html };
  }

  const css = cssChunks.join("\n\n");

  // Replace the first <style> block with a <link> tag, remove the rest
  let replaced = false;
  const updatedHtml = html.replace(styleRegex, () => {
    if (!replaced) {
      replaced = true;
      return `<link rel="stylesheet" href="styles.css">`;
    }
    return "";
  });

  return { css, html: updatedHtml };
}

/**
 * Migrate a legacy single-HTML app to the multi-file src/ layout.
 *
 * Steps:
 *   1. Read existing index.html
 *   2. Create {appId}/src/ directory
 *   3. Copy HTML content to src/index.html (with inline styles extracted)
 *   4. Create src/main.tsx placeholder entry point
 *   5. If inline styles found, write src/styles.css
 *   6. Update app metadata to formatVersion: 2
 *   7. Keep root index.html untouched (legacy fallback)
 */
export function migrateAppToMultifile(appId: string): MigrationResult {
  const app = getApp(appId);
  if (!app) {
    return { ok: false, error: `App not found: ${appId}` };
  }

  // Already migrated — treat as no-op
  if (isMultifileApp(app)) {
    return { ok: true };
  }

  const appsDir = getAppsDir();
  const appDir = join(appsDir, appId);
  const rootIndex = join(appDir, "index.html");

  if (!existsSync(rootIndex)) {
    return { ok: false, error: `Root index.html not found for app ${appId}` };
  }

  const originalHtml = readFileSync(rootIndex, "utf-8");

  // Create src/ directory
  const srcDir = join(appDir, "src");
  mkdirSync(srcDir, { recursive: true });

  // Extract inline styles if present
  const { css, html: processedHtml } = extractInlineStyles(originalHtml);

  // Write src/index.html
  writeFileSync(join(srcDir, "index.html"), processedHtml, "utf-8");

  // Write src/main.tsx placeholder
  const styleImport = css ? "import './styles.css';\n" : "";
  const mainTsx = `// Entry point — migrated from legacy single-file app\n${styleImport}\nconsole.log('App loaded');\n`;
  writeFileSync(join(srcDir, "main.tsx"), mainTsx, "utf-8");

  // Write src/styles.css if styles were extracted
  if (css) {
    writeFileSync(join(srcDir, "styles.css"), css, "utf-8");
  }

  // Update metadata to formatVersion 2
  const metadataPath = join(appsDir, `${appId}.json`);
  const rawMeta = readFileSync(metadataPath, "utf-8");
  const metadata = JSON.parse(rawMeta);
  metadata.formatVersion = 2;
  metadata.updatedAt = Date.now();
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

  return { ok: true };
}
