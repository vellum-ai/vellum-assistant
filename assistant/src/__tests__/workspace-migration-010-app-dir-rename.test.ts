import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { appDirRenameMigration } from "../workspace/migrations/010-app-dir-rename.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;
let appsDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-010-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  appsDir = join(workspaceDir, "data", "apps");
  mkdirSync(appsDir, { recursive: true });
}

function writeAppJson(filename: string, data: Record<string, unknown>): void {
  writeFileSync(join(appsDir, filename), JSON.stringify(data, null, 2));
}

function readAppJson(filename: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(appsDir, filename), "utf-8"));
}

function createUuidApp(
  id: string,
  name: string,
  opts?: { preview?: string; indexHtml?: string },
): void {
  // JSON file at {id}.json
  writeAppJson(`${id}.json`, { id, name, schemaJson: "{}" });

  // App directory at {id}/
  const appDir = join(appsDir, id);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(appDir, "index.html"),
    opts?.indexHtml ?? `<h1>${name}</h1>`,
    "utf-8",
  );

  // Preview file at {id}.preview
  if (opts?.preview) {
    writeFileSync(join(appsDir, `${id}.preview`), opts.preview, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("010-app-dir-rename migration", () => {
  test("renames UUID-named app files/dirs to slugified names with dirName in JSON", () => {
    const id = "aaaaaaaa-1111-2222-3333-444444444444";
    createUuidApp(id, "My Cool App", { preview: "preview-data" });

    appDirRenameMigration.run(workspaceDir);

    // Old files should be gone
    expect(existsSync(join(appsDir, `${id}.json`))).toBe(false);
    expect(existsSync(join(appsDir, id))).toBe(false);
    expect(existsSync(join(appsDir, `${id}.preview`))).toBe(false);

    // New files should exist
    expect(existsSync(join(appsDir, "my-cool-app.json"))).toBe(true);
    expect(existsSync(join(appsDir, "my-cool-app"))).toBe(true);
    expect(existsSync(join(appsDir, "my-cool-app.preview"))).toBe(true);

    // JSON should have dirName set
    const json = readAppJson("my-cool-app.json");
    expect(json.dirName).toBe("my-cool-app");
    expect(json.id).toBe(id);

    // index.html should be in the new directory
    expect(
      readFileSync(join(appsDir, "my-cool-app", "index.html"), "utf-8"),
    ).toBe("<h1>My Cool App</h1>");

    // Preview content preserved
    expect(readFileSync(join(appsDir, "my-cool-app.preview"), "utf-8")).toBe(
      "preview-data",
    );
  });

  test("idempotency: running migration again produces no errors or changes", () => {
    const id = "bbbbbbbb-1111-2222-3333-444444444444";
    createUuidApp(id, "Idempotent App");

    // Run twice
    appDirRenameMigration.run(workspaceDir);
    const jsonAfterFirst = readAppJson("idempotent-app.json");

    appDirRenameMigration.run(workspaceDir);
    const jsonAfterSecond = readAppJson("idempotent-app.json");

    expect(jsonAfterSecond).toEqual(jsonAfterFirst);
    expect(existsSync(join(appsDir, "idempotent-app"))).toBe(true);
  });

  test("partial-rename recovery: JSON has dirName but files still at UUID", () => {
    const id = "cccccccc-1111-2222-3333-444444444444";
    const dirName = "partial-app";

    // Simulate crash: JSON was updated with dirName but files weren't renamed
    writeAppJson(`${id}.json`, {
      id,
      name: "Partial App",
      dirName,
      schemaJson: "{}",
    });
    // Files still at UUID locations
    mkdirSync(join(appsDir, id), { recursive: true });
    writeFileSync(join(appsDir, id, "index.html"), "<h1>Partial</h1>", "utf-8");
    writeFileSync(join(appsDir, `${id}.preview`), "partial-preview", "utf-8");

    appDirRenameMigration.run(workspaceDir);

    // UUID files should be gone, dirName files should exist
    expect(existsSync(join(appsDir, `${id}.json`))).toBe(false);
    expect(existsSync(join(appsDir, id))).toBe(false);
    expect(existsSync(join(appsDir, `${id}.preview`))).toBe(false);

    expect(existsSync(join(appsDir, `${dirName}.json`))).toBe(true);
    expect(existsSync(join(appsDir, dirName))).toBe(true);
    expect(existsSync(join(appsDir, `${dirName}.preview`))).toBe(true);

    const json = readAppJson(`${dirName}.json`);
    expect(json.dirName).toBe(dirName);
  });

  test("missing directories: JSON exists but no app dir — still sets dirName and renames JSON", () => {
    const id = "dddddddd-1111-2222-3333-444444444444";
    // JSON exists but no corresponding directory
    writeAppJson(`${id}.json`, { id, name: "No Dir App", schemaJson: "{}" });

    appDirRenameMigration.run(workspaceDir);

    // Old JSON gone
    expect(existsSync(join(appsDir, `${id}.json`))).toBe(false);

    // New JSON and directory created
    expect(existsSync(join(appsDir, "no-dir-app.json"))).toBe(true);
    expect(existsSync(join(appsDir, "no-dir-app"))).toBe(true);

    const json = readAppJson("no-dir-app.json");
    expect(json.dirName).toBe("no-dir-app");
  });

  test("missing preview files produce no error, JSON and dir still renamed", () => {
    const id = "eeeeeeee-1111-2222-3333-444444444444";
    // Create app without preview
    writeAppJson(`${id}.json`, {
      id,
      name: "No Preview",
      schemaJson: "{}",
    });
    mkdirSync(join(appsDir, id), { recursive: true });
    writeFileSync(
      join(appsDir, id, "index.html"),
      "<h1>No Preview</h1>",
      "utf-8",
    );

    appDirRenameMigration.run(workspaceDir);

    expect(existsSync(join(appsDir, "no-preview.json"))).toBe(true);
    expect(existsSync(join(appsDir, "no-preview"))).toBe(true);
    expect(existsSync(join(appsDir, "no-preview.preview"))).toBe(false);
  });

  test("duplicate names after slugification get numeric suffixes", () => {
    const id1 = "ffffffff-1111-2222-3333-444444444444";
    const id2 = "gggggggg-1111-2222-3333-444444444444";
    createUuidApp(id1, "Same Name");
    createUuidApp(id2, "Same Name");

    appDirRenameMigration.run(workspaceDir);

    // Both should exist with deduped names
    const jsonFiles = readdirSync(appsDir)
      .filter((f) => f.endsWith(".json"))
      .sort();

    // One should be "same-name.json", the other "same-name-2.json"
    expect(jsonFiles).toContain("same-name.json");
    expect(jsonFiles).toContain("same-name-2.json");

    // Both should have dirName set
    const json1 = readAppJson("same-name.json");
    const json2 = readAppJson("same-name-2.json");
    expect(json1.dirName).toBe("same-name");
    expect(json2.dirName).toBe("same-name-2");

    // Both directories should exist
    expect(existsSync(join(appsDir, "same-name"))).toBe(true);
    expect(existsSync(join(appsDir, "same-name-2"))).toBe(true);
  });

  test("emoji-only app names get fallback slug", () => {
    const id = "hhhhhhhh-1111-2222-3333-444444444444";
    writeAppJson(`${id}.json`, { id, name: "🚀🎉", schemaJson: "{}" });
    mkdirSync(join(appsDir, id), { recursive: true });
    writeFileSync(join(appsDir, id, "index.html"), "<h1>Emoji</h1>", "utf-8");

    appDirRenameMigration.run(workspaceDir);

    // Old files should be gone
    expect(existsSync(join(appsDir, `${id}.json`))).toBe(false);

    // Find the new JSON file (has app- prefix fallback)
    const jsonFiles = readdirSync(appsDir).filter(
      (f) => f.endsWith(".json") && f !== `${id}.json`,
    );
    expect(jsonFiles.length).toBe(1);
    expect(jsonFiles[0]).toMatch(/^app-[a-f0-9]{8}\.json$/);

    const json = readAppJson(jsonFiles[0]);
    expect(json.dirName).toMatch(/^app-[a-f0-9]{8}$/);
    expect(json.id).toBe(id);
  });

  test("empty app name falls back to 'untitled' slug", () => {
    const id = "iiiiiiii-1111-2222-3333-444444444444";
    // name is absent — migration defaults to "untitled"
    writeAppJson(`${id}.json`, { id, schemaJson: "{}" });
    mkdirSync(join(appsDir, id), { recursive: true });
    writeFileSync(join(appsDir, id, "index.html"), "<h1>No Name</h1>", "utf-8");

    appDirRenameMigration.run(workspaceDir);

    expect(existsSync(join(appsDir, "untitled.json"))).toBe(true);
    const json = readAppJson("untitled.json");
    expect(json.dirName).toBe("untitled");
  });

  test("no-op when apps directory does not exist", () => {
    // Remove the apps directory
    rmSync(appsDir, { recursive: true, force: true });

    // Should not throw
    expect(() => appDirRenameMigration.run(workspaceDir)).not.toThrow();
  });

  test("no-op when apps directory is empty", () => {
    expect(() => appDirRenameMigration.run(workspaceDir)).not.toThrow();
  });
});
