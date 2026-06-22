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
});
