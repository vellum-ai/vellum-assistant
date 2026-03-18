import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { compileApp, readCompileStatus } from "../bundler/app-compiler.js";
import {
  ALLOWED_PACKAGES,
  getCacheDir,
  isBareImport,
  packageName,
  resolvePackage,
} from "../bundler/package-resolver.js";

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

    const status = readCompileStatus(appDir);
    expect(status?.ok).toBe(false);
    expect(status?.errors.length).toBeGreaterThan(0);
  });

  test("preserves the last successful dist output when a later build fails", async () => {
    const appDir = await scaffold("stale-dist-guard", {
      "main.tsx": `console.log("version one");`,
      "index.html": MINIMAL_HTML,
    });

    const initialResult = await compileApp(appDir);
    expect(initialResult.ok).toBe(true);

    const originalJs = await readFile(join(appDir, "dist", "main.js"), "utf-8");

    await writeFile(
      join(appDir, "src", "main.tsx"),
      `const broken = <<<INVALID>>>;`,
    );

    const failedResult = await compileApp(appDir);
    expect(failedResult.ok).toBe(false);

    const preservedJs = await readFile(
      join(appDir, "dist", "main.js"),
      "utf-8",
    );
    expect(preservedJs).toBe(originalJs);

    const status = readCompileStatus(appDir);
    expect(status?.ok).toBe(false);
    expect(status?.errors[0]?.text).toBeTruthy();
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

  test("disallowed package import produces a clear error", async () => {
    const appDir = await scaffold("disallowed-pkg", {
      "main.tsx": `import leftpad from "left-pad";\nconsole.log(leftpad("hi", 5));`,
      "index.html": MINIMAL_HTML,
    });

    const result = await compileApp(appDir);

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].text).toContain("left-pad");
  });

  test("allowed package (zod) compiles successfully", async () => {
    const appDir = await scaffold("allowed-pkg-zod", {
      "main.tsx": `import { z } from "zod";\nconst schema = z.string();\nconsole.log(schema.parse("hello"));`,
      "index.html": MINIMAL_HTML,
    });

    const result = await compileApp(appDir);

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);

    const js = await readFile(join(appDir, "dist", "main.js"), "utf-8");
    expect(js.length).toBeGreaterThan(100);
  }, 30_000);

  test("allowed package uses shared cache on second build", async () => {
    // First build installs the package
    const appDir1 = await scaffold("cache-test-1", {
      "main.tsx": `import { z } from "zod";\nconsole.log(z.string());`,
      "index.html": MINIMAL_HTML,
    });
    const r1 = await compileApp(appDir1);
    expect(r1.ok).toBe(true);

    // The cache dir should now have zod
    const cacheDir = getCacheDir();
    expect(existsSync(join(cacheDir, "node_modules", "zod"))).toBe(true);

    // Second build should reuse the cache (no install needed)
    const appDir2 = await scaffold("cache-test-2", {
      "main.tsx": `import { z } from "zod";\nconst s = z.number();\nconsole.log(s.parse(42));`,
      "index.html": MINIMAL_HTML,
    });
    const r2 = await compileApp(appDir2);
    expect(r2.ok).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Package resolver unit tests
// ---------------------------------------------------------------------------

describe("package-resolver", () => {
  test("isBareImport identifies bare specifiers", () => {
    expect(isBareImport("date-fns")).toBe(true);
    expect(isBareImport("zod")).toBe(true);
    expect(isBareImport("@scope/pkg")).toBe(true);
    expect(isBareImport("./local")).toBe(false);
    expect(isBareImport("../parent")).toBe(false);
    expect(isBareImport("/absolute")).toBe(false);
    expect(isBareImport("preact")).toBe(false);
    expect(isBareImport("preact/hooks")).toBe(false);
    expect(isBareImport("react")).toBe(false);
    expect(isBareImport("react-dom")).toBe(false);
  });

  test("packageName extracts top-level name", () => {
    expect(packageName("date-fns")).toBe("date-fns");
    expect(packageName("date-fns/format")).toBe("date-fns");
    expect(packageName("@scope/pkg")).toBe("@scope/pkg");
    expect(packageName("@scope/pkg/sub")).toBe("@scope/pkg");
  });

  test("resolvePackage returns null for disallowed packages", async () => {
    const result = await resolvePackage("left-pad");
    expect(result).toBeNull();
  });

  test("ALLOWED_PACKAGES contains expected entries", () => {
    expect(ALLOWED_PACKAGES).toContain("date-fns");
    expect(ALLOWED_PACKAGES).toContain("chart.js");
    expect(ALLOWED_PACKAGES).toContain("lodash-es");
    expect(ALLOWED_PACKAGES).toContain("zod");
    expect(ALLOWED_PACKAGES).toContain("clsx");
    expect(ALLOWED_PACKAGES).toContain("lucide");
  });
});
