import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger so a skipped-file warning doesn't spam the test output.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getWorkflow, listWorkflows } from "./library.js";

// Each test points VELLUM_WORKSPACE_DIR at a fresh temp dir, so `getWorkspaceDir`
// resolves there and saved workflows live at `<temp>/workflows/*.workflow.ts`.
let workspaceDir: string;
let prevOverride: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "wf-library-"));
  prevOverride = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
});

afterEach(() => {
  if (prevOverride === undefined) delete process.env.VELLUM_WORKSPACE_DIR;
  else process.env.VELLUM_WORKSPACE_DIR = prevOverride;
  rmSync(workspaceDir, { recursive: true, force: true });
});

/** Write `<workspace>/workflows/<file>` with `source` (creating the dir). */
function writeWorkflow(file: string, source: string): void {
  const dir = join(workspaceDir, "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), source, "utf8");
}

/** Write `<workspace>/workflows/<name>/workflow.ts` (directory-style). */
function writeDirWorkflow(name: string, source: string): void {
  const dir = join(workspaceDir, "workflows", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workflow.ts"), source, "utf8");
}

describe("listWorkflows", () => {
  test("returns [] and does not create the dir when none exists", () => {
    expect(listWorkflows()).toEqual([]);
    // A second call still sees no dir — listing never creates it eagerly.
    expect(getWorkflow("anything")).toBeNull();
  });

  test("lists workflows with a statically-extractable meta", () => {
    writeWorkflow(
      "digest.workflow.ts",
      `export const meta = { name: "daily-digest", description: "Summarize the day" };\nreturn agent("go");`,
    );
    writeWorkflow(
      "research.workflow.ts",
      `export const meta = { name: "research", description: "Research a topic" };\nreturn agent("go");`,
    );

    const entries = listWorkflows().sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      name: "daily-digest",
      description: "Summarize the day",
    });
    expect(entries[0]!.path).toContain("digest.workflow.ts");
    expect(entries[1]).toMatchObject({
      name: "research",
      description: "Research a topic",
    });
  });

  test("ignores non-`.workflow.ts` files", () => {
    writeWorkflow(
      "real.workflow.ts",
      `export const meta = { name: "real", description: "d" };\nreturn 1;`,
    );
    writeWorkflow(
      "notes.ts",
      `export const meta = { name: "x", description: "y" };`,
    );
    writeWorkflow("README.md", `# not a workflow`);

    const entries = listWorkflows();
    expect(entries.map((e) => e.name)).toEqual(["real"]);
  });

  test("includes both flat and directory-style workflows", () => {
    writeWorkflow(
      "flat.workflow.ts",
      `export const meta = { name: "flat-wf", description: "flat" };\nreturn 1;`,
    );
    writeDirWorkflow(
      "dir-wf",
      `export const meta = { name: "dir-wf", description: "dir" };\nreturn 1;`,
    );

    const entries = listWorkflows().sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    expect(entries.map((e) => e.name)).toEqual(["dir-wf", "flat-wf"]);
    expect(entries[0]!.path).toContain(join("dir-wf", "workflow.ts"));
    expect(entries[1]!.path).toContain("flat.workflow.ts");
  });

  test("ignores a subdir without a workflow.ts and does not recurse deeper", () => {
    writeWorkflow(
      "real.workflow.ts",
      `export const meta = { name: "real", description: "d" };\nreturn 1;`,
    );
    // Subdir with no entry-point workflow.ts.
    mkdirSync(join(workspaceDir, "workflows", "empty-dir"), {
      recursive: true,
    });
    writeFileSync(
      join(workspaceDir, "workflows", "empty-dir", "notes.ts"),
      `export const meta = { name: "ignored", description: "d" };`,
      "utf8",
    );
    // A nested workflow.ts one level deeper than supported must not be picked up.
    mkdirSync(join(workspaceDir, "workflows", "outer", "inner"), {
      recursive: true,
    });
    writeFileSync(
      join(workspaceDir, "workflows", "outer", "inner", "workflow.ts"),
      `export const meta = { name: "too-deep", description: "d" };`,
      "utf8",
    );

    expect(listWorkflows().map((e) => e.name)).toEqual(["real"]);
  });

  test("skips a file whose meta is computed/non-literal (cannot be statically extracted)", () => {
    writeWorkflow(
      "ok.workflow.ts",
      `export const meta = { name: "ok", description: "fine" };\nreturn 1;`,
    );
    // Computed meta: a call expression cannot be statically extracted and the
    // file is skipped rather than failing the whole listing.
    writeWorkflow(
      "computed.workflow.ts",
      `const make = () => ({ name: "nope", description: "d" });\nexport const meta = make();\nreturn 1;`,
    );
    // Missing meta entirely.
    writeWorkflow("nometa.workflow.ts", `return agent("go");`);

    const entries = listWorkflows();
    expect(entries.map((e) => e.name)).toEqual(["ok"]);
  });
});

describe("getWorkflow", () => {
  test("resolves by meta.name", () => {
    const source = `export const meta = { name: "daily-digest", description: "d" };\nreturn agent("go");`;
    writeWorkflow("digest.workflow.ts", source);

    const resolved = getWorkflow("daily-digest");
    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe(source);
    expect(resolved!.path).toContain("digest.workflow.ts");
  });

  test("falls back to the filename base when no meta.name matches", () => {
    // meta.name is "canonical" but the caller asks by the file base "byfile".
    const source = `export const meta = { name: "canonical", description: "d" };\nreturn 1;`;
    writeWorkflow("byfile.workflow.ts", source);

    expect(getWorkflow("byfile")!.source).toBe(source);
    // The canonical meta.name also resolves.
    expect(getWorkflow("canonical")!.source).toBe(source);
  });

  test("returns null for an unknown name", () => {
    writeWorkflow(
      "real.workflow.ts",
      `export const meta = { name: "real", description: "d" };\nreturn 1;`,
    );
    expect(getWorkflow("ghost")).toBeNull();
  });

  test("resolves a directory-style workflow by meta.name", () => {
    const source = `export const meta = { name: "dir-digest", description: "d" };\nreturn agent("go");`;
    writeDirWorkflow("dir-digest", source);

    const resolved = getWorkflow("dir-digest");
    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe(source);
    expect(resolved!.path).toContain(join("dir-digest", "workflow.ts"));
  });

  test("resolves a directory-style workflow by directory name when meta.name differs", () => {
    // meta.name is "canonical" but the dir (and caller's name) is "by-dir".
    const source = `export const meta = { name: "canonical", description: "d" };\nreturn 1;`;
    writeDirWorkflow("by-dir", source);

    expect(getWorkflow("by-dir")!.source).toBe(source);
    // The canonical meta.name also resolves.
    expect(getWorkflow("canonical")!.source).toBe(source);
  });

  test("prefers a meta.name match over a base-name match", () => {
    // Asking for "wanted" should hit the file whose meta.name is "wanted",
    // not the file whose base name is "wanted" (whose meta.name differs).
    writeWorkflow(
      "wanted.workflow.ts",
      `export const meta = { name: "other", description: "by base name" };\nreturn 1;`,
    );
    const metaSource = `export const meta = { name: "wanted", description: "by meta name" };\nreturn 1;`;
    writeWorkflow("real.workflow.ts", metaSource);

    expect(getWorkflow("wanted")!.source).toBe(metaSource);
  });
});

describe("name collisions (fail closed)", () => {
  test("a base-name collision (dir + flat) resolves NEITHER", () => {
    writeWorkflow(
      "foo.workflow.ts",
      `export const meta = { name: "foo", description: "flat" };\nreturn "FLAT";`,
    );
    writeDirWorkflow(
      "foo",
      `export const meta = { name: "foo", description: "dir" };\nreturn "DIR";`,
    );

    // Neither the base name nor the (shared) meta.name resolves.
    expect(getWorkflow("foo")).toBeNull();
    expect(listWorkflows().filter((e) => e.name === "foo")).toHaveLength(0);
  });

  test("a base-name collision hides both sides' own meta.names", () => {
    writeWorkflow(
      "bar.workflow.ts",
      `export const meta = { name: "flat-name", description: "flat" };\nreturn "FLAT";`,
    );
    writeDirWorkflow(
      "bar",
      `export const meta = { name: "dir-name", description: "dir" };\nreturn "DIR";`,
    );

    expect(getWorkflow("dir-name")).toBeNull();
    expect(getWorkflow("flat-name")).toBeNull();
    expect(getWorkflow("bar")).toBeNull();
    expect(listWorkflows()).toEqual([]);
  });

  test("a base-name collision does not affect unrelated workflows", () => {
    writeWorkflow(
      "foo.workflow.ts",
      `export const meta = { name: "foo", description: "flat" };\nreturn "FLAT";`,
    );
    writeDirWorkflow(
      "foo",
      `export const meta = { name: "foo", description: "dir" };\nreturn "DIR";`,
    );
    // A separate, non-colliding workflow still resolves normally.
    writeWorkflow(
      "safe.workflow.ts",
      `export const meta = { name: "safe", description: "ok" };\nreturn "SAFE";`,
    );

    expect(getWorkflow("safe")!.source).toContain("SAFE");
    expect(listWorkflows().map((e) => e.name)).toEqual(["safe"]);
  });

  test("a duplicate meta.name across different files resolves NEITHER", () => {
    // Distinct base names, same meta.name → fail closed (no hijack by order).
    writeWorkflow(
      "a.workflow.ts",
      `export const meta = { name: "dup", description: "from-a" };\nreturn "A";`,
    );
    writeDirWorkflow(
      "b",
      `export const meta = { name: "dup", description: "from-b" };\nreturn "B";`,
    );

    expect(getWorkflow("dup")).toBeNull();
    expect(listWorkflows().filter((e) => e.name === "dup")).toHaveLength(0);
    // Each file is still reachable by its unambiguous base name.
    expect(getWorkflow("a")!.source).toContain("A");
    expect(getWorkflow("b")!.source).toContain("B");
  });
});
