import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { compileApp } from "../bundler/app-compiler.js";

// ---------------------------------------------------------------------------
// Shared temp directory
// ---------------------------------------------------------------------------

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "app-compiler-test-"));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Scaffold a minimal app directory with src/main.tsx and src/index.html. */
async function scaffold(
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const appDir = join(tempDir, name);
  const srcDir = join(appDir, "src");
  await mkdir(srcDir, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    const filePath = join(srcDir, filename);
    await writeFile(filePath, content);
  }
  return appDir;
}

const MINIMAL_HTML = `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compileApp", () => {
  test("compiles minimal TSX app and produces dist/main.js + dist/index.html", async () => {
    const appDir = await scaffold("basic", {
      "main.tsx": `const App = () => { const el = document.createElement("div"); el.textContent = "hello"; return el; }; App();`,
      "index.html": MINIMAL_HTML,
    });

    const result = await compileApp(appDir);

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.durationMs).toBeLessThan(5000);

    // dist/main.js should exist and contain bundled code
    const js = await readFile(join(appDir, "dist", "main.js"), "utf-8");
    expect(js.length).toBeGreaterThan(0);

    // dist/index.html should exist and have the script tag injected
    const html = await readFile(join(appDir, "dist", "index.html"), "utf-8");
    expect(html).toContain('src="main.js"');
    expect(html).toContain('type="module"');
  });

  test("compiles preact JSX correctly", async () => {
    const appDir = await scaffold("preact-jsx", {
      "main.tsx": `import { render } from "preact";
const App = () => <div>Hello</div>;
render(<App />, document.body);`,
      "index.html": MINIMAL_HTML,
    });

    const result = await compileApp(appDir);

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);

    const js = await readFile(join(appDir, "dist", "main.js"), "utf-8");
    // The output should contain preact's runtime code (bundled)
    expect(js.length).toBeGreaterThan(100);
  });

  test("strips TypeScript types", async () => {
    const appDir = await scaffold("ts-types", {
      "main.tsx": `interface Greeting { name: string; }
const greet = (g: Greeting): string => g.name;
console.log(greet({ name: "world" }));`,
      "index.html": MINIMAL_HTML,
    });

    const result = await compileApp(appDir);

    expect(result.ok).toBe(true);

    const js = await readFile(join(appDir, "dist", "main.js"), "utf-8");
    // Interface declarations should be stripped
    expect(js).not.toContain("interface");
    expect(js).toContain("world");
  });

  test("CSS imports produce dist/main.css and inject link tag", async () => {
    const appDir = await scaffold("css-import", {
      "main.tsx": `import "./style.css";
console.log("styled");`,
      "style.css": `body { background: red; }`,
      "index.html": MINIMAL_HTML,
    });

    const result = await compileApp(appDir);

    expect(result.ok).toBe(true);

    const css = await readFile(join(appDir, "dist", "main.css"), "utf-8");
    expect(css).toContain("background");

    const html = await readFile(join(appDir, "dist", "index.html"), "utf-8");
    expect(html).toContain('href="main.css"');
    expect(html).toContain("stylesheet");
  });

  test("returns ok: false with diagnostics on syntax error", async () => {
    const appDir = await scaffold("syntax-error", {
      "main.tsx": `const x: number = <<<INVALID>>>;`,
      "index.html": MINIMAL_HTML,
    });

    const result = await compileApp(appDir);

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].text).toBeTruthy();
  });

  test("dist/index.html has script tag injected", async () => {
    const appDir = await scaffold("script-injection", {
      "main.tsx": `console.log("hi");`,
      "index.html": `<!DOCTYPE html>
<html>
<head><title>Inject Test</title></head>
<body>
<div id="app"></div>
</body>
</html>`,
    });

    const result = await compileApp(appDir);
    expect(result.ok).toBe(true);

    const html = await readFile(join(appDir, "dist", "index.html"), "utf-8");
    expect(html).toContain('<script type="module" src="main.js"></script>');
    // Original content should be preserved
    expect(html).toContain('<div id="app"></div>');
  });

  test("does not duplicate script tag if already present", async () => {
    const appDir = await scaffold("no-dup-script", {
      "main.tsx": `console.log("hi");`,
      "index.html": `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
<script type="module" src="main.js"></script>
</body>
</html>`,
    });

    const result = await compileApp(appDir);
    expect(result.ok).toBe(true);

    const html = await readFile(join(appDir, "dist", "index.html"), "utf-8");
    const matches = html.match(/src="main\.js"/g);
    expect(matches).toHaveLength(1);
  });
});
