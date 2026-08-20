/**
 * Guards that importing `@vellumai/plugin-api` does not force a DB-graph
 * module's named exports to resolve.
 *
 * Plugin suites routinely partial-mock modules in the persistence/embeddings
 * graph (a handful of functions, not the whole surface). `mock.module` replaces
 * the module for every importer, so a static edge from plugin-api into that
 * graph makes some unrelated host module import a name the partial mock does not
 * define, and the entire suite fails to instantiate with
 * `SyntaxError: Export named '...' not found in module`. Facades over DB-graph
 * writers therefore load them through a dynamic `import()` inside the wrapper.
 *
 * The probe runs in a subprocess: `mock.module` is process-wide and permanent,
 * so mocking the embedding backend in this process would leak into every other
 * suite sharing the test process.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const PLUGIN_API_DIR = join(import.meta.dir, "..");

let probeDir: string | null = null;

afterEach(() => {
  if (probeDir !== null) {
    rmSync(probeDir, { recursive: true, force: true });
    probeDir = null;
  }
});

describe("plugin-api import graph", () => {
  test("instantiates against a partial-mocked DB-graph module", () => {
    // GIVEN a probe suite that partial-mocks a DB-graph module the way plugin
    // suites do (one function, not the module's full export surface) and then
    // imports the public plugin API surface.
    probeDir = mkdtempSync(join(tmpdir(), "plugin-api-import-graph-"));
    const probe = join(probeDir, "probe.test.ts");
    writeFileSync(
      probe,
      `import { expect, mock, test } from "bun:test";\n` +
        `mock.module(${JSON.stringify(join(PLUGIN_API_DIR, "..", "persistence", "embeddings", "embedding-backend.ts"))}, () => ({\n` +
        `  embedWithBackend: async () => [],\n` +
        `}));\n` +
        `test("plugin-api instantiates", async () => {\n` +
        `  const api = await import(${JSON.stringify(join(PLUGIN_API_DIR, "index.ts"))});\n` +
        `  expect(typeof api.persistSystemCard).toEqual("function");\n` +
        `  expect(typeof api.addMessage).toEqual("function");\n` +
        `});\n`,
    );

    // WHEN the probe suite runs in its own process.
    const result = spawnSync(process.execPath, ["test", probe], {
      cwd: join(PLUGIN_API_DIR, "..", ".."),
      encoding: "utf8",
      timeout: 60_000,
    });

    // THEN plugin-api instantiated, so nothing in its static import graph
    // reached a name the partial mock left undefined.
    expect(`${result.stdout}${result.stderr}`).not.toContain("SyntaxError");
    expect(result.status).toBe(0);
  });
});
