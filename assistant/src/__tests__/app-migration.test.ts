import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { migrateAppToMultifile } from "../memory/app-migration.js";
import { createApp, getApp, getAppsDir } from "../memory/app-store.js";

// Redirect app storage to a temp directory for test isolation
const tmpDir = join(import.meta.dir, ".tmp-app-migration-test");

mock.module("../util/platform.js", () => ({
  getDataDir: () => tmpDir,
  isContainerized: () => false,
}));

describe("migrateAppToMultifile", () => {
  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("migrates a simple HTML app to src/ layout", () => {
    const app = createApp({
      name: "Test App",
      schemaJson: "{}",
      htmlDefinition: "<html><body>Hello</body></html>",
    });

    const result = migrateAppToMultifile(app.id);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    const appDir = join(getAppsDir(), app.id);

    // Root index.html is preserved
    expect(existsSync(join(appDir, "index.html"))).toBe(true);
    expect(readFileSync(join(appDir, "index.html"), "utf-8")).toBe(
      "<html><body>Hello</body></html>",
    );

    // src/index.html created
    expect(existsSync(join(appDir, "src", "index.html"))).toBe(true);

    // src/main.tsx created
    const mainTsx = readFileSync(join(appDir, "src", "main.tsx"), "utf-8");
    expect(mainTsx).toContain("Entry point");
    // No inline styles in source HTML → no styles.css import
    expect(mainTsx).not.toContain("import './styles.css'");
  });

  test("sets formatVersion to 2 after migration", () => {
    const app = createApp({
      name: "Version Test",
      schemaJson: "{}",
      htmlDefinition: "<html><body>Hi</body></html>",
    });

    expect(app.formatVersion).toBeUndefined();

    migrateAppToMultifile(app.id);

    const updated = getApp(app.id);
    expect(updated).not.toBeNull();
    expect(updated!.formatVersion).toBe(2);
  });

  test("extracts inline styles to CSS file", () => {
    const htmlWithStyle = `<html>
<head><style>body { color: red; }</style></head>
<body>Styled</body>
</html>`;

    const app = createApp({
      name: "Styled App",
      schemaJson: "{}",
      htmlDefinition: htmlWithStyle,
    });

    const result = migrateAppToMultifile(app.id);
    expect(result.ok).toBe(true);

    const appDir = join(getAppsDir(), app.id);

    // styles.css should contain the extracted CSS
    const css = readFileSync(join(appDir, "src", "styles.css"), "utf-8");
    expect(css).toContain("body { color: red; }");

    // src/index.html should have a <link> tag instead of <style>
    const srcHtml = readFileSync(join(appDir, "src", "index.html"), "utf-8");
    expect(srcHtml).toContain('<link rel="stylesheet" href="styles.css">');
    expect(srcHtml).not.toContain("<style>");
  });

  test("extracts multiple inline style blocks", () => {
    const html = `<html>
<head><style>.a { margin: 0; }</style></head>
<body><style>.b { padding: 0; }</style></body>
</html>`;

    const app = createApp({
      name: "Multi Style",
      schemaJson: "{}",
      htmlDefinition: html,
    });

    migrateAppToMultifile(app.id);

    const appDir = join(getAppsDir(), app.id);
    const css = readFileSync(join(appDir, "src", "styles.css"), "utf-8");
    expect(css).toContain(".a { margin: 0; }");
    expect(css).toContain(".b { padding: 0; }");
  });

  test("migration of already-migrated app is a no-op", () => {
    const app = createApp({
      name: "Already Migrated",
      schemaJson: "{}",
      htmlDefinition: "<html><body>Done</body></html>",
    });

    const first = migrateAppToMultifile(app.id);
    expect(first.ok).toBe(true);

    // Grab the updatedAt after first migration
    const afterFirst = getApp(app.id);
    const firstUpdatedAt = afterFirst!.updatedAt;

    // Small delay so updatedAt would differ if re-written
    const second = migrateAppToMultifile(app.id);
    expect(second.ok).toBe(true);

    // formatVersion should still be 2
    const afterSecond = getApp(app.id);
    expect(afterSecond!.formatVersion).toBe(2);

    // updatedAt should NOT have changed (no-op)
    expect(afterSecond!.updatedAt).toBe(firstUpdatedAt);
  });

  test("returns error when app not found", () => {
    const result = migrateAppToMultifile("nonexistent-id-12345");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("App not found");
  });
});
