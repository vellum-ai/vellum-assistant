import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  readPage,
  writePage,
} from "../../../plugins/defaults/memory/v2/page-store.js";
import type { ConceptPageFrontmatter } from "../../../plugins/defaults/memory/v2/types.js";
import { backfillV3LeavesMigration } from "../092-backfill-v3-leaves.js";

describe("092 backfill v3 leaves", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(tmpdir(), "ws-mig-leaves-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  async function writeAssignments(
    assignments: Record<string, string[]>,
  ): Promise<void> {
    const dataDir = path.join(workspaceDir, "memory", "v3", "data");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "assignments.json"),
      JSON.stringify(assignments),
      "utf8",
    );
  }

  async function seedPage(
    slug: string,
    frontmatter: Partial<ConceptPageFrontmatter> = {},
    body = "Body text.\n",
  ): Promise<void> {
    await writePage(workspaceDir, {
      slug,
      frontmatter: {
        edges: [],
        ref_files: [],
        ref_urls: [],
        ...frontmatter,
      },
      body,
    });
  }

  it("backfills leaves from assignments.json onto assigned pages", async () => {
    await writeAssignments({
      "page-a": ["domain-a/topic-x", "domain-a/topic-y"],
      "page-b": ["domain-b/topic-z"],
    });
    await seedPage("page-a", { summary: "Page A summary" });
    await seedPage("page-b");

    await backfillV3LeavesMigration.run(workspaceDir);

    const pageA = await readPage(workspaceDir, "page-a");
    const pageB = await readPage(workspaceDir, "page-b");
    expect(pageA?.frontmatter.leaves).toEqual([
      "domain-a/topic-x",
      "domain-a/topic-y",
    ]);
    expect(pageB?.frontmatter.leaves).toEqual(["domain-b/topic-z"]);
    // Other frontmatter and body preserved.
    expect(pageA?.frontmatter.summary).toBe("Page A summary");
    expect(pageA?.body).toContain("Body text.");
  });

  it("never clobbers a page that already has non-empty leaves", async () => {
    await writeAssignments({ "page-a": ["domain-a/topic-new"] });
    await seedPage("page-a", { leaves: ["domain-a/topic-existing"] });

    await backfillV3LeavesMigration.run(workspaceDir);

    const pageA = await readPage(workspaceDir, "page-a");
    expect(pageA?.frontmatter.leaves).toEqual(["domain-a/topic-existing"]);
  });

  it("fills a page whose leaves field is present but empty", async () => {
    await writeAssignments({ "page-a": ["domain-a/topic-x"] });
    await seedPage("page-a", { leaves: [] });

    await backfillV3LeavesMigration.run(workspaceDir);

    const pageA = await readPage(workspaceDir, "page-a");
    expect(pageA?.frontmatter.leaves).toEqual(["domain-a/topic-x"]);
  });

  it("is idempotent across re-runs", async () => {
    await writeAssignments({ "page-a": ["domain-a/topic-x"] });
    await seedPage("page-a");

    await backfillV3LeavesMigration.run(workspaceDir);
    const pagePath = path.join(workspaceDir, "memory", "concepts", "page-a.md");
    const first = await fs.readFile(pagePath, "utf8");

    await backfillV3LeavesMigration.run(workspaceDir);
    const second = await fs.readFile(pagePath, "utf8");

    expect(second).toBe(first);
  });

  it("skips slugs that have no matching page", async () => {
    await writeAssignments({ "page-missing": ["domain-a/topic-x"] });

    // Should not throw even though no page exists for the slug.
    await backfillV3LeavesMigration.run(workspaceDir);

    const missing = await readPage(workspaceDir, "page-missing");
    expect(missing).toBeNull();
  });

  it("is a no-op when assignments.json is absent", async () => {
    await seedPage("page-a");

    await backfillV3LeavesMigration.run(workspaceDir);

    const pageA = await readPage(workspaceDir, "page-a");
    expect(pageA?.frontmatter.leaves).toBeUndefined();
  });
});
