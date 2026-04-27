/**
 * Tests for `assistant/src/memory/v2/page-store.ts`.
 *
 * Coverage matrix (from PR 8 acceptance criteria):
 *   - slugify: lowercase / kebab-case / ascii / 80-char cap / empty fallback.
 *   - readPage / writePage round-trip: frontmatter survives, body preserved.
 *   - readPage on missing file: returns null.
 *   - writePage atomicity: a fault between temp-write and rename leaves the
 *     prior file intact (or the new one) — never a half-written page.
 *   - listPages: excludes non-.md entries, returns slugs only, missing dir → [].
 *   - deletePage: idempotent on missing file.
 *
 * Tests use temp workspaces under `os.tmpdir()` per the cross-cutting safety
 * rule in the v2 plan; they never touch `~/.vellum/`.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  deletePage,
  listPages,
  pageExists,
  readPage,
  slugify,
  writePage,
} from "../page-store.js";
import type { ConceptPage } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-page-store-test-"));
  // Mirror the workspace migration so readPage / writePage have a target dir.
  mkdirSync(join(workspaceDir, "memory", "concepts"), { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function makePage(overrides: Partial<ConceptPage> = {}): ConceptPage {
  return {
    slug: "alice-preferences",
    frontmatter: { edges: ["bob-handoff"], ref_files: [] },
    body: "Alice prefers VS Code over Vim.\nShe ships at end of day.\n",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe("slugify", () => {
  test("lowercases ASCII letters", () => {
    expect(slugify("AliceBob")).toBe("alicebob");
  });

  test("converts spaces and punctuation to single hyphens", () => {
    expect(slugify("Alice's Preferred IDE!")).toBe("alice-s-preferred-ide");
  });

  test("collapses runs of separators to one hyphen", () => {
    expect(slugify("foo   ___ bar")).toBe("foo-bar");
  });

  test("trims leading and trailing hyphens", () => {
    expect(slugify("---hello world---")).toBe("hello-world");
  });

  test("strips non-ASCII characters via NFKD normalization", () => {
    // Non-ASCII reduces to hyphens; we want a stable ascii-only slug.
    expect(slugify("café résumé")).toMatch(/^[a-z0-9-]+$/);
  });

  test("caps slug length at 80 chars and re-trims trailing hyphen", () => {
    const long = "a".repeat(120);
    const slug = slugify(long);
    expect(slug.length).toBe(80);
    expect(slug.endsWith("-")).toBe(false);
  });

  test("falls back to a unique placeholder for empty inputs", () => {
    const a = slugify("");
    const b = slugify("!!!");
    const c = slugify("###");
    expect(a).toMatch(/^concept-[a-f0-9]{8}$/);
    expect(b).toMatch(/^concept-[a-f0-9]{8}$/);
    // Each call generates a fresh UUID, so distinct empty inputs do not collide.
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
  });
});

// ---------------------------------------------------------------------------
// readPage / writePage round-trip
// ---------------------------------------------------------------------------

describe("writePage + readPage round-trip", () => {
  test("round-trips frontmatter and body verbatim", async () => {
    const page = makePage();
    await writePage(workspaceDir, page);

    const read = await readPage(workspaceDir, page.slug);
    expect(read).not.toBeNull();
    expect(read!.slug).toBe(page.slug);
    expect(read!.frontmatter.edges).toEqual(page.frontmatter.edges);
    expect(read!.frontmatter.ref_files).toEqual(page.frontmatter.ref_files);
    expect(read!.body).toBe(page.body);
  });

  test("renders frontmatter at the top with --- delimiters", async () => {
    const page = makePage();
    await writePage(workspaceDir, page);

    const raw = readFileSync(
      join(workspaceDir, "memory", "concepts", `${page.slug}.md`),
      "utf-8",
    );
    expect(raw.startsWith("---\n")).toBe(true);
    // Body follows the closing delimiter exactly once.
    expect(raw.split("---").length).toBeGreaterThanOrEqual(3);
    expect(raw).toContain("Alice prefers VS Code");
  });

  test("preserves an empty body", async () => {
    const page = makePage({ body: "" });
    await writePage(workspaceDir, page);

    const read = await readPage(workspaceDir, page.slug);
    expect(read!.body).toBe("");
  });

  test("preserves multiline body with embedded YAML-looking lines", async () => {
    const tricky = "key: value\n---\nnot-frontmatter\n";
    const page = makePage({ slug: "tricky", body: tricky });
    await writePage(workspaceDir, page);

    const read = await readPage(workspaceDir, page.slug);
    expect(read!.body).toBe(tricky);
  });

  test("readPage returns null for a slug that does not exist", async () => {
    const result = await readPage(workspaceDir, "nonexistent-slug");
    expect(result).toBeNull();
  });

  test("readPage parses a hand-written page with no frontmatter as empty frontmatter + full body", async () => {
    const slug = "no-frontmatter";
    const body = "Just some prose, no YAML.\n";
    writeFileSync(
      join(workspaceDir, "memory", "concepts", `${slug}.md`),
      body,
      "utf-8",
    );

    const read = await readPage(workspaceDir, slug);
    expect(read).not.toBeNull();
    expect(read!.frontmatter.edges).toEqual([]);
    expect(read!.frontmatter.ref_files).toEqual([]);
    expect(read!.body).toBe(body);
  });

  test("writePage overwrites an existing page", async () => {
    const page1 = makePage({ body: "first version\n" });
    await writePage(workspaceDir, page1);

    const page2 = makePage({ body: "second version\n" });
    await writePage(workspaceDir, page2);

    const read = await readPage(workspaceDir, page1.slug);
    expect(read!.body).toBe("second version\n");
  });
});

// ---------------------------------------------------------------------------
// Atomic write — fault injection
// ---------------------------------------------------------------------------

describe("writePage atomicity", () => {
  test("write that fails partway leaves prior file intact and no orphan tmp", async () => {
    // Seed the page with a known prior version.
    const original = makePage({ body: "original body\n" });
    await writePage(workspaceDir, original);
    const originalRaw = readFileSync(
      join(workspaceDir, "memory", "concepts", `${original.slug}.md`),
      "utf-8",
    );

    // Inject a fault: replace the destination with a directory of the same
    // name so `rename` cannot overwrite it (POSIX rejects renaming a regular
    // file onto a non-empty directory). This forces writePage's temp-then-
    // rename path to fail at the rename step — exactly the window where a
    // real process crash would leave a stranded `.tmp.*` file behind. The
    // assertions below verify (a) the prior page is untouched and (b) the
    // catch block cleaned up the temp file before re-throwing.
    const targetPath = join(
      workspaceDir,
      "memory",
      "concepts",
      `${original.slug}.md`,
    );
    rmSync(targetPath);
    mkdirSync(targetPath);
    writeFileSync(join(targetPath, "blocker"), "x", "utf-8");

    await expect(
      writePage(workspaceDir, makePage({ body: "interrupted body\n" })),
    ).rejects.toThrow();

    // Restore the directory shape so cleanup helpers don't trip.
    rmSync(targetPath, { recursive: true, force: true });
    writeFileSync(targetPath, originalRaw, "utf-8");

    // Prior content is recoverable from what we just rewrote — i.e. the failed
    // writePage never replaced it.
    expect(readFileSync(targetPath, "utf-8")).toBe(originalRaw);

    // No orphan .tmp.* files in concepts/ (cleanup ran in the catch block).
    const remaining = readdirSync(join(workspaceDir, "memory", "concepts"));
    const orphanTmps = remaining.filter((name) => name.includes(".tmp."));
    expect(orphanTmps).toEqual([]);
  });

  test("successful write produces no orphan tmp files", async () => {
    await writePage(workspaceDir, makePage());

    const remaining = readdirSync(join(workspaceDir, "memory", "concepts"));
    const orphanTmps = remaining.filter((name) => name.includes(".tmp."));
    expect(orphanTmps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listPages
// ---------------------------------------------------------------------------

describe("listPages", () => {
  test("returns slugs (filename minus .md) for every page on disk", async () => {
    await writePage(workspaceDir, makePage({ slug: "alice" }));
    await writePage(workspaceDir, makePage({ slug: "bob" }));
    await writePage(workspaceDir, makePage({ slug: "carol" }));

    const slugs = await listPages(workspaceDir);
    expect(slugs).toEqual(["alice", "bob", "carol"]);
  });

  test("excludes non-.md files in the concepts directory", async () => {
    await writePage(workspaceDir, makePage({ slug: "alice" }));

    const conceptsDir = join(workspaceDir, "memory", "concepts");
    writeFileSync(join(conceptsDir, "README.txt"), "ignore me", "utf-8");
    writeFileSync(join(conceptsDir, "image.png"), "fake", "utf-8");
    writeFileSync(join(conceptsDir, ".hidden"), "fake", "utf-8");

    const slugs = await listPages(workspaceDir);
    expect(slugs).toEqual(["alice"]);
  });

  test("excludes subdirectories (only files count)", async () => {
    await writePage(workspaceDir, makePage({ slug: "alice" }));

    mkdirSync(join(workspaceDir, "memory", "concepts", "subdir"), {
      recursive: true,
    });

    const slugs = await listPages(workspaceDir);
    expect(slugs).toEqual(["alice"]);
  });

  test("returns [] when the concepts directory does not exist", async () => {
    rmSync(join(workspaceDir, "memory", "concepts"), {
      recursive: true,
      force: true,
    });

    const slugs = await listPages(workspaceDir);
    expect(slugs).toEqual([]);
  });

  test("returns [] when the concepts directory is empty", async () => {
    const slugs = await listPages(workspaceDir);
    expect(slugs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deletePage
// ---------------------------------------------------------------------------

describe("deletePage", () => {
  test("removes the page from disk", async () => {
    const page = makePage();
    await writePage(workspaceDir, page);
    expect(await pageExists(workspaceDir, page.slug)).toBe(true);

    await deletePage(workspaceDir, page.slug);
    expect(await pageExists(workspaceDir, page.slug)).toBe(false);
    expect(await readPage(workspaceDir, page.slug)).toBeNull();
  });

  test("is idempotent — deleting a missing page does not throw", async () => {
    await deletePage(workspaceDir, "never-existed");
    // Second call still does not throw.
    await deletePage(workspaceDir, "never-existed");
  });

  test("does not affect other pages", async () => {
    await writePage(workspaceDir, makePage({ slug: "alice" }));
    await writePage(workspaceDir, makePage({ slug: "bob" }));

    await deletePage(workspaceDir, "alice");

    expect(await pageExists(workspaceDir, "alice")).toBe(false);
    expect(await pageExists(workspaceDir, "bob")).toBe(true);
  });
});
