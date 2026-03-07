import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";

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
}));

// Mock content-id to avoid pulling in crypto internals
mock.module("../util/content-id.js", () => ({
  computeContentId: () => "abcd1234abcd1234",
}));

// Mock bundle-signer (not exercised in these tests)
mock.module("./bundle-signer.js", () => ({
  signBundle: async () => ({}),
}));

import { packageApp } from "../bundler/app-bundler.js";
import type { AppManifest } from "../bundler/manifest.js";

// ---------------------------------------------------------------------------
// packageApp
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
   * Helper: set up a fake app on disk with src/ and dist/ dirs
   * so that compileApp can succeed.
   */
  function setupApp(appId: string, opts?: { withCss?: boolean }) {
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
      name: "Test App",
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

  test("packages an app with compiled dist/ files in the zip", async () => {
    const appId = "multi-test-1";
    setupApp(appId, { withCss: true });

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

  test("sets format_version to 2 in manifest", async () => {
    const appId = "multi-test-2";
    setupApp(appId);

    const result = await packageApp(appId);
    const zipData = await readFile(result.bundlePath);
    const zip = await JSZip.loadAsync(zipData);

    const manifestJson = await zip.file("manifest.json")!.async("string");
    const manifest: AppManifest = JSON.parse(manifestJson);

    expect(manifest.format_version).toBe(2);
    expect(manifest.entry).toBe("index.html");
    expect(manifest.name).toBe("Test App");
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

  test("app without CSS omits main.css from zip", async () => {
    const appId = "multi-no-css";
    setupApp(appId, { withCss: false });

    const result = await packageApp(appId);
    const zipData = await readFile(result.bundlePath);
    const zip = await JSZip.loadAsync(zipData);

    expect(zip.file("index.html")).not.toBeNull();
    expect(zip.file("main.js")).not.toBeNull();
    expect(zip.file("main.css")).toBeNull();
  });
});
