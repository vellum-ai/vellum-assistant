/**
 * Unit tests for the `delete_memory_page` tool's execute path.
 *
 * The tool is a thin, guardian-gated wrapper over `deletePage` (whose
 * slug-validation and idempotency are covered in `v2/page-store.test.ts`).
 * These tests pin the wrapper's own contract: the guardian capability check,
 * the empty-slug guard, and that a guardian call actually removes the page
 * file. A real temp workspace is used (no module mocks) so the test exercises
 * the real `getWorkspaceDir` → `deletePage` wiring.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ToolContext } from "../../../../tools/types.js";
import { deleteMemoryPageTool } from "../tools.js";
import { pageExists, writePage } from "../v2/page-store.js";

let workspace: string;
let prevWorkspaceEnv: string | undefined;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "delete-memory-page-"));
  prevWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspace;
});

afterEach(() => {
  if (prevWorkspaceEnv === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = prevWorkspaceEnv;
  }
  rmSync(workspace, { recursive: true, force: true });
});

function ctx(trustClass: string): ToolContext {
  return { trustClass } as unknown as ToolContext;
}

async function seedPage(slug: string): Promise<void> {
  await writePage(workspace, {
    slug,
    frontmatter: { edges: [], ref_files: [], ref_urls: [] },
    body: "seed body\n",
  });
}

describe("delete_memory_page tool", () => {
  test("removes the concept page for a guardian turn", async () => {
    await seedPage("people/alice");
    expect(await pageExists(workspace, "people/alice")).toBe(true);

    const result = await deleteMemoryPageTool.execute(
      { slug: "people/alice", activity: "retire merged page" },
      ctx("guardian"),
    );

    expect(result.isError).toBeFalsy();
    expect(await pageExists(workspace, "people/alice")).toBe(false);
  });

  test("refuses outside guardian trust and leaves the page intact", async () => {
    await seedPage("alice");

    const result = await deleteMemoryPageTool.execute(
      { slug: "alice", activity: "attempt delete" },
      ctx("trusted_contact"),
    );

    expect(result.isError).toBe(true);
    expect(await pageExists(workspace, "alice")).toBe(true);
  });

  test("rejects an empty/whitespace slug", async () => {
    const result = await deleteMemoryPageTool.execute(
      { slug: "   ", activity: "x" },
      ctx("guardian"),
    );

    expect(result.isError).toBe(true);
  });

  test("is idempotent on a page that does not exist", async () => {
    const result = await deleteMemoryPageTool.execute(
      { slug: "never-existed", activity: "x" },
      ctx("guardian"),
    );

    expect(result.isError).toBeFalsy();
  });

  test("surfaces an error for a traversal-shaped slug rather than escaping the tree", async () => {
    const result = await deleteMemoryPageTool.execute(
      { slug: "../escape", activity: "x" },
      ctx("guardian"),
    );

    expect(result.isError).toBe(true);
  });
});
