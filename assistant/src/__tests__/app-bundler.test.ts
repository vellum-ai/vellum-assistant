import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import JSZip from "jszip";

// Mock the logger before importing the module under test
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Temp directory for fake app data used in packageApp tests
const testAppsDir = join(tmpdir(), `app-bundler-test-${Date.now()}`);

// Mock app-store so packageApp can find our test apps
const mockApps = new Map<string, Record<string, unknown>>();
mock.module("../memory/app-store.js", () => ({
  getApp: (id: string) => mockApps.get(id) ?? null,
  getAppsDir: () => testAppsDir,
  isMultifileApp: (app: Record<string, unknown>) => app.formatVersion === 2,
}));

// Mock content-id to avoid pulling in crypto internals
mock.module("../util/content-id.js", () => ({
  computeContentId: () => "abcd1234abcd1234",
}));

// Mock bundle-signer (not exercised in these tests)
mock.module("./bundle-signer.js", () => ({
  signBundle: async () => ({}),
}));

import {
  extractRemoteUrls,
  materializeAssets,
  packageApp,
} from "../bundler/app-bundler.js";
import type { AppManifest } from "../bundler/manifest.js";

// ---------------------------------------------------------------------------
// extractRemoteUrls
// ---------------------------------------------------------------------------

describe("extractRemoteUrls", () => {
  test("extracts src attributes with double quotes", () => {
    const html = '<img src="https://cdn.example.com/logo.png">';
    expect(extractRemoteUrls(html)).toEqual([
      "https://cdn.example.com/logo.png",
    ]);
  });

  test("extracts src attributes with single quotes", () => {
    const html = "<img src='https://cdn.example.com/logo.png'>";
    expect(extractRemoteUrls(html)).toEqual([
      "https://cdn.example.com/logo.png",
    ]);
  });

  test("extracts unquoted src attributes", () => {
    const html = "<img src=https://cdn.example.com/logo.png>";
    expect(extractRemoteUrls(html)).toEqual([
      "https://cdn.example.com/logo.png",
    ]);
  });

  test("extracts href attributes", () => {
    const html =
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Roboto">';
    expect(extractRemoteUrls(html)).toEqual([
      "https://fonts.googleapis.com/css?family=Roboto",
    ]);
  });

  test("extracts CSS url() references with double quotes", () => {
    const html =
      '<div style="background: url(&quot;https://cdn.example.com/bg.jpg&quot;)"></div>';
    // The regex matches url("...") literally, not HTML entities
    expect(extractRemoteUrls(html)).toEqual([]);

    // With actual quotes in a <style> block
    const html2 =
      '<style>body { background: url("https://cdn.example.com/bg.jpg"); }</style>';
    expect(extractRemoteUrls(html2)).toEqual([
      "https://cdn.example.com/bg.jpg",
    ]);
  });

  test("extracts CSS url() references with single quotes", () => {
    const html =
      "<style>body { background: url('https://cdn.example.com/bg.jpg'); }</style>";
    expect(extractRemoteUrls(html)).toEqual(["https://cdn.example.com/bg.jpg"]);
  });

  test("extracts CSS url() references without quotes", () => {
    const html =
      "<style>body { background: url(https://cdn.example.com/bg.jpg); }</style>";
    expect(extractRemoteUrls(html)).toEqual(["https://cdn.example.com/bg.jpg"]);
  });

  test("ignores relative URLs", () => {
    const html = '<img src="images/logo.png"><link href="./style.css">';
    expect(extractRemoteUrls(html)).toEqual([]);
  });

  test("ignores data URIs", () => {
    const html = '<img src="data:image/png;base64,iVBORw0KGgo=">';
    expect(extractRemoteUrls(html)).toEqual([]);
  });

  test("deduplicates identical URLs", () => {
    const html = `
      <img src="https://cdn.example.com/logo.png">
      <img src="https://cdn.example.com/logo.png">
    `;
    expect(extractRemoteUrls(html)).toEqual([
      "https://cdn.example.com/logo.png",
    ]);
  });

  test("extracts multiple different URLs", () => {
    const html = `
      <img src="https://cdn.example.com/logo.png">
      <link href="https://fonts.example.com/style.css">
      <script src="https://cdn.example.com/app.js"></script>
    `;
    const urls = extractRemoteUrls(html);
    expect(urls).toHaveLength(3);
    expect(urls).toContain("https://cdn.example.com/logo.png");
    expect(urls).toContain("https://fonts.example.com/style.css");
    expect(urls).toContain("https://cdn.example.com/app.js");
  });

  test("returns empty array for HTML with no remote URLs", () => {
    const html = "<html><body><p>Hello World</p></body></html>";
    expect(extractRemoteUrls(html)).toEqual([]);
  });

  test("handles mixed src, href, and url() in a single document", () => {
    const html = `
      <link href="https://example.com/a.css">
      <img src="https://example.com/b.png">
      <style>div { background: url(https://example.com/c.jpg); }</style>
    `;
    const urls = extractRemoteUrls(html);
    expect(urls).toHaveLength(3);
  });

  test("handles HTTP (not just HTTPS)", () => {
    const html = '<img src="http://cdn.example.com/legacy.png">';
    expect(extractRemoteUrls(html)).toEqual([
      "http://cdn.example.com/legacy.png",
    ]);
  });
});

// ---------------------------------------------------------------------------
// materializeAssets
// ---------------------------------------------------------------------------

describe("materializeAssets", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns unchanged HTML when there are no remote URLs", async () => {
    const html = "<html><body>No remote assets</body></html>";
    const result = await materializeAssets(html);
    expect(result.rewrittenHtml).toBe(html);
    expect(result.assets).toEqual([]);
  });

  test("fetches remote assets and rewrites URLs", async () => {
    const imageUrl = "https://cdn.example.com/image.png";
    const imageData = Buffer.from("fake-image-data");

    globalThis.fetch = mock((url: string) => {
      if (url === imageUrl) {
        return Promise.resolve(new Response(imageData, { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const html = `<img src="${imageUrl}">`;
    const result = await materializeAssets(html);

    expect(result.rewrittenHtml).toBe('<img src="assets/e724846245db.png">');
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].archivePath).toBe("assets/e724846245db.png");
    expect(result.assets[0].data).toEqual(imageData);
  });

  test("handles multiple distinct assets", async () => {
    const urls = [
      "https://cdn.example.com/a.png",
      "https://cdn.example.com/b.css",
      "https://cdn.example.com/c.js",
    ];

    globalThis.fetch = mock((url: string) => {
      return Promise.resolve(
        new Response(Buffer.from(`data-for-${url}`), { status: 200 }),
      );
    }) as unknown as typeof fetch;

    const html = `
      <img src="${urls[0]}">
      <link href="${urls[1]}">
      <script src="${urls[2]}"></script>
    `;
    const result = await materializeAssets(html);

    expect(result.assets).toHaveLength(3);

    const expectedFilenames: Record<string, string> = {
      "https://cdn.example.com/a.png": "6155f67efa62.png",
      "https://cdn.example.com/b.css": "5e6d8d571910.css",
      "https://cdn.example.com/c.js": "20fb1ea9b4c9.js",
    };
    for (const url of urls) {
      expect(result.rewrittenHtml).toContain(
        `assets/${expectedFilenames[url]}`,
      );
      expect(result.rewrittenHtml).not.toContain(url);
    }
  });

  test("keeps original URL when fetch returns non-OK status", async () => {
    const imageUrl = "https://cdn.example.com/missing.png";

    globalThis.fetch = mock(() => {
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const html = `<img src="${imageUrl}">`;
    const result = await materializeAssets(html);

    expect(result.rewrittenHtml).toBe(html);
    expect(result.assets).toEqual([]);
  });

  test("keeps original URL when fetch throws (network error)", async () => {
    const imageUrl = "https://cdn.example.com/unreachable.png";

    globalThis.fetch = mock(() => {
      return Promise.reject(new Error("Network error"));
    }) as unknown as typeof fetch;

    const html = `<img src="${imageUrl}">`;
    const result = await materializeAssets(html);

    expect(result.rewrittenHtml).toBe(html);
    expect(result.assets).toEqual([]);
  });

  test("partially succeeds: fetched assets are rewritten, failed ones remain", async () => {
    const goodUrl = "https://cdn.example.com/good.png";
    const badUrl = "https://cdn.example.com/bad.png";

    globalThis.fetch = mock((url: string) => {
      if (url === goodUrl) {
        return Promise.resolve(
          new Response(Buffer.from("good-data"), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 500 }));
    }) as unknown as typeof fetch;

    const html = `<img src="${goodUrl}"><img src="${badUrl}">`;
    const result = await materializeAssets(html);

    expect(result.rewrittenHtml).toContain("assets/691e2a787421.png");
    expect(result.rewrittenHtml).toContain(badUrl);
    expect(result.assets).toHaveLength(1);
  });

  test("deduplicates same URL appearing multiple times in HTML", async () => {
    const imageUrl = "https://cdn.example.com/icon.png";
    let fetchCount = 0;

    globalThis.fetch = mock(() => {
      fetchCount++;
      return Promise.resolve(
        new Response(Buffer.from("icon-data"), { status: 200 }),
      );
    }) as unknown as typeof fetch;

    const html = `<img src="${imageUrl}"><div style="background: url(${imageUrl})"></div>`;
    const result = await materializeAssets(html);

    // Should only fetch once since extractRemoteUrls deduplicates
    expect(fetchCount).toBe(1);
    expect(result.assets).toHaveLength(1);

    // Both occurrences should be rewritten
    expect(result.rewrittenHtml).not.toContain(imageUrl);
    const matches = result.rewrittenHtml.match(/assets\/2f7fc0f99275\.png/g);
    expect(matches).toHaveLength(2);
  });

  test("preserves file extensions in asset filenames", async () => {
    const pngUrl = "https://cdn.example.com/image.png";
    const cssUrl = "https://cdn.example.com/style.css";
    const noExtUrl = "https://cdn.example.com/api/data";

    globalThis.fetch = mock(() => {
      return Promise.resolve(
        new Response(Buffer.from("data"), { status: 200 }),
      );
    }) as unknown as typeof fetch;

    const html = `<img src="${pngUrl}"><link href="${cssUrl}"><img src="${noExtUrl}">`;
    const result = await materializeAssets(html);

    expect(result.assets).toHaveLength(3);

    const pngAsset = result.assets.find((a) => a.archivePath.endsWith(".png"));
    const cssAsset = result.assets.find((a) => a.archivePath.endsWith(".css"));
    const noExtAsset = result.assets.find(
      (a) => !a.archivePath.endsWith(".png") && !a.archivePath.endsWith(".css"),
    );

    expect(pngAsset).toBeDefined();
    expect(cssAsset).toBeDefined();
    expect(noExtAsset).toBeDefined();
  });

  test("rewrites CSS url() references alongside src/href", async () => {
    const cssUrl = "https://cdn.example.com/bg.jpg";

    globalThis.fetch = mock(() => {
      return Promise.resolve(
        new Response(Buffer.from("jpg-data"), { status: 200 }),
      );
    }) as unknown as typeof fetch;

    const html =
      '<style>body { background: url("https://cdn.example.com/bg.jpg"); }</style>';
    const result = await materializeAssets(html);

    expect(result.rewrittenHtml).toContain("assets/8550eecd4975.jpg");
    expect(result.rewrittenHtml).not.toContain(cssUrl);
  });
});

// ---------------------------------------------------------------------------
// packageApp — multifile apps
// ---------------------------------------------------------------------------

describe("packageApp", () => {
  afterEach(() => {
    mockApps.clear();
    try {
      rmSync(testAppsDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  /**
   * Helper: set up a fake multifile app on disk with src/ and dist/ dirs
   * so that compileApp (which we mock below) can pretend to succeed.
   */
  function setupMultifileApp(appId: string, opts?: { withCss?: boolean }) {
    const appDir = join(testAppsDir, appId);
    const srcDir = join(appDir, "src");
    mkdirSync(srcDir, { recursive: true });

    // Write minimal src/ so the app directory looks valid
    if (opts?.withCss) {
      writeFileSync(join(srcDir, "styles.css"), "body { margin: 0; }");
      writeFileSync(
        join(srcDir, "main.tsx"),
        'import "./styles.css";\nexport default () => "hi";',
      );
    } else {
      writeFileSync(join(srcDir, "main.tsx"), 'export default () => "hi";');
    }
    writeFileSync(
      join(srcDir, "index.html"),
      "<!DOCTYPE html><html><head></head><body></body></html>",
    );

    // Write the app JSON (getApp reads from {appsDir}/{id}.json)
    const appDef = {
      id: appId,
      name: "Test Multifile App",
      description: "A test app",
      schemaJson: "{}",
      htmlDefinition: "<unused>",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      formatVersion: 2,
    };
    writeFileSync(join(testAppsDir, `${appId}.json`), JSON.stringify(appDef));
    mockApps.set(appId, appDef);

    return appDef;
  }

  function setupLegacyApp(appId: string) {
    const appDir = join(testAppsDir, appId);
    mkdirSync(appDir, { recursive: true });

    const appDef = {
      id: appId,
      name: "Test Legacy App",
      schemaJson: "{}",
      htmlDefinition: "<html><body>Hello legacy</body></html>",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    writeFileSync(join(testAppsDir, `${appId}.json`), JSON.stringify(appDef));
    mockApps.set(appId, appDef);
    return appDef;
  }

  test("packages a multifile app with compiled dist/ files in the zip", async () => {
    const appId = "multi-test-1";
    setupMultifileApp(appId, { withCss: true });

    const result = await packageApp(appId);
    const zipData = await readFile(result.bundlePath);
    const zip = await JSZip.loadAsync(zipData);

    // Verify compiled files are present
    expect(zip.file("index.html")).not.toBeNull();
    expect(zip.file("main.js")).not.toBeNull();
    expect(zip.file("main.css")).not.toBeNull();
    expect(zip.file("manifest.json")).not.toBeNull();

    // Verify content matches what we wrote to dist/
    const indexContent = await zip.file("index.html")!.async("string");
    expect(indexContent).toContain('src="main.js"');

    // main.js should contain compiled output (esbuild minifies the source)
    const jsContent = await zip.file("main.js")!.async("string");
    expect(jsContent.length).toBeGreaterThan(0);

    // CSS was imported, so main.css should be present
    const cssContent = await zip.file("main.css")!.async("string");
    expect(cssContent).toContain("margin");
  });

  test("sets format_version to 2 in manifest for multifile apps", async () => {
    const appId = "multi-test-2";
    setupMultifileApp(appId);

    const result = await packageApp(appId);
    const zipData = await readFile(result.bundlePath);
    const zip = await JSZip.loadAsync(zipData);

    const manifestJson = await zip.file("manifest.json")!.async("string");
    const manifest: AppManifest = JSON.parse(manifestJson);

    expect(manifest.format_version).toBe(2);
    expect(manifest.entry).toBe("index.html");
    expect(manifest.name).toBe("Test Multifile App");
  });

  test("compile failure produces a clear error", async () => {
    const appId = "multi-fail-1";
    const appDir = join(testAppsDir, appId);
    const srcDir = join(appDir, "src");
    mkdirSync(srcDir, { recursive: true });

    // Write intentionally broken source so esbuild fails
    writeFileSync(join(srcDir, "main.tsx"), "const x: number = {{{BROKEN");
    writeFileSync(
      join(srcDir, "index.html"),
      "<!DOCTYPE html><html><head></head><body></body></html>",
    );

    const appDef = {
      id: appId,
      name: "Broken App",
      schemaJson: "{}",
      htmlDefinition: "<unused>",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      formatVersion: 2,
    };
    writeFileSync(join(testAppsDir, `${appId}.json`), JSON.stringify(appDef));
    mockApps.set(appId, appDef);

    await expect(packageApp(appId)).rejects.toThrow(
      /Compilation failed for app "Broken App"/,
    );
  });

  test("legacy app packaging remains unchanged (format_version 1)", async () => {
    const appId = "legacy-test-1";
    setupLegacyApp(appId);

    const result = await packageApp(appId);
    const zipData = await readFile(result.bundlePath);
    const zip = await JSZip.loadAsync(zipData);

    const manifestJson = await zip.file("manifest.json")!.async("string");
    const manifest: AppManifest = JSON.parse(manifestJson);

    expect(manifest.format_version).toBe(1);

    // Legacy app should have index.html with the original content
    const indexContent = await zip.file("index.html")!.async("string");
    expect(indexContent).toContain("Hello legacy");

    // Should NOT have main.js (not a compiled app)
    expect(zip.file("main.js")).toBeNull();
  });

  test("multifile app without CSS omits main.css from zip", async () => {
    const appId = "multi-no-css";
    setupMultifileApp(appId, { withCss: false });

    const result = await packageApp(appId);
    const zipData = await readFile(result.bundlePath);
    const zip = await JSZip.loadAsync(zipData);

    expect(zip.file("index.html")).not.toBeNull();
    expect(zip.file("main.js")).not.toBeNull();
    expect(zip.file("main.css")).toBeNull();
  });
});
