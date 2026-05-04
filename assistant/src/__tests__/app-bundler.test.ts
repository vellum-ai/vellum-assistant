import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  getAppDirPath: (id: string) => join(testAppsDir, id),
  isMultifileApp: (app: Record<string, unknown>) => app.formatVersion === 2,
}));

// Mock content-id to avoid pulling in crypto internals
mock.module("../util/content-id.js", () => ({
  computeContentId: () => "abcd1234abcd1234",
}));

let compileAppOverride:
  | ((appDir: string) => Promise<{
      ok: boolean;
      errors: Array<{
        text: string;
        location?: { file: string; line: number; column: number };
      }>;
      warnings: Array<{ text: string }>;
      durationMs: number;
    }>)
  | undefined;

async function compileAppFixture(appDir: string) {
  if (compileAppOverride) {
    return compileAppOverride(appDir);
  }

  const srcDir = join(appDir, "src");
  const distDir = join(appDir, "dist");
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  let html = readFileSync(join(srcDir, "index.html"), "utf-8");
  const cssPath = join(srcDir, "styles.css");
  if (existsSync(cssPath)) {
    writeFileSync(join(distDir, "main.css"), readFileSync(cssPath));
    html = html.replace(
      "</head>",
      '  <link rel="stylesheet" href="main.css">\n  </head>',
    );
  }
  html = html.replace(
    "</body>",
    '  <script type="module" src="main.js"></script>\n  </body>',
  );

  writeFileSync(join(distDir, "index.html"), html);
  writeFileSync(join(distDir, "main.js"), "console.log('compiled');");

  return { ok: true, errors: [], warnings: [], durationMs: 1 };
}

mock.module("../bundler/app-compiler.js", () => ({
  compileApp: compileAppFixture,
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
    compileAppOverride = undefined;
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

  function setupLegacyApp(appId: string) {
    const appDir = join(testAppsDir, appId);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, "index.html"),
      "<!DOCTYPE html><html><body><h1>Legacy</h1></body></html>",
    );

    const appDef = {
      id: appId,
      name: "Legacy App",
      description: "A legacy app",
      schemaJson: "{}",
      htmlDefinition: "<unused>",
      createdAt: Date.now(),
      updatedAt: Date.now(),
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
    compileAppOverride = async () => ({
      ok: false,
      errors: [
        {
          text: "Expected identifier",
          location: { file: "src/main.tsx", line: 1, column: 20 },
        },
      ],
      warnings: [],
      durationMs: 1,
    });

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

  test("rejects formatVersion 2 apps missing src files before bundling", async () => {
    const appId = "multi-missing-src";
    const appDir = join(testAppsDir, appId);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, "index.html"),
      "<!DOCTYPE html><html><body><h1>Wrong root</h1></body></html>",
    );

    const appDef = {
      id: appId,
      name: "Missing Source App",
      schemaJson: "{}",
      htmlDefinition: "<unused>",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      formatVersion: 2,
    };
    writeFileSync(join(testAppsDir, `${appId}.json`), JSON.stringify(appDef));
    mockApps.set(appId, appDef);

    await expect(packageApp(appId)).rejects.toThrow(
      /missing src\/index\.html and src\/main\.tsx/,
    );
  });

  test("rejects app_create scaffold before sharing", async () => {
    const appId = "multi-default-scaffold";
    const appDir = join(testAppsDir, appId);
    const srcDir = join(appDir, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "index.html"),
      '<!DOCTYPE html><html><body><div id="app"></div></body></html>',
    );
    writeFileSync(
      join(srcDir, "main.tsx"),
      `import { render } from 'preact';

function App() {
  return <div>{"Hello, Scaffold!"}</div>;
}

render(<App />, document.getElementById('app')!);
`,
    );

    const appDef = {
      id: appId,
      name: "Scaffold App",
      schemaJson: "{}",
      htmlDefinition: "<unused>",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      formatVersion: 2,
    };
    writeFileSync(join(testAppsDir, `${appId}.json`), JSON.stringify(appDef));
    mockApps.set(appId, appDef);

    await expect(packageApp(appId)).rejects.toThrow(
      /still has the default src\/main\.tsx scaffold/,
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

  test("keeps legacy single-file apps packageable", async () => {
    const appId = "legacy-single-file";
    setupLegacyApp(appId);

    const result = await packageApp(appId);
    const zipData = await readFile(result.bundlePath);
    const zip = await JSZip.loadAsync(zipData);

    const indexContent = await zip.file("index.html")!.async("string");
    const manifestJson = await zip.file("manifest.json")!.async("string");
    const manifest: AppManifest = JSON.parse(manifestJson);

    expect(indexContent).toContain("<h1>Legacy</h1>");
    expect(manifest.format_version).toBe(1);
  });
});
