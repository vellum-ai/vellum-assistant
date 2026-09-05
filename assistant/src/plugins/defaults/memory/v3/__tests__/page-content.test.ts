/**
 * Tests for `page-content.ts`, the v3 injection entry renderer:
 *   - a lead injection carries the page's `[current: …]` annotation directly
 *     under the header, rendered from the frontmatter the page store keeps
 *     beside the body (the line that makes a state-shaped selection pick the
 *     page must reach the model with it);
 *   - a page without `current:` renders header + head only;
 *   - a matched heading section never carries the annotation; a matched lead
 *     does; a missing page renders nothing.
 *
 * Pages are written to a temp workspace. `getWorkspaceDir` is stubbed with
 * the usual delegating mock (`mock.module` is process-global) so sibling
 * files in a directory run keep the real resolver.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

const realPaths = { ...(await import("../../paths.js")) };
let pageContentMockActive = false;
let workspaceDir = "";
mock.module("../../paths.js", () => ({
  ...realPaths,
  getWorkspaceDir: () =>
    pageContentMockActive ? workspaceDir : realPaths.getWorkspaceDir(),
}));

const { parsePageContent, writePage } =
  await import("../../substrate/page-store.js");
const { renderV3InjectionEntry, renderV3SectionInjection } =
  await import("../page-content.js");
const { leadSectionOfBody, sectionHeadLine } = await import("../sections.js");

const PAGE_A_BODY = "# Page A\nlead prose\n\n## Notes\nnote body";

beforeAll(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), "page-content-"));
  pageContentMockActive = true;
  await writePage(
    workspaceDir,
    parsePageContent(
      "page-a",
      `---\ntitle: Page A\ncurrent: "Waiting on   the vendor reply"\n---\n${PAGE_A_BODY}`,
    ),
  );
  await writePage(
    workspaceDir,
    parsePageContent("page-b", "---\ntitle: Page B\n---\n# Page B\nlead b"),
  );
});

afterAll(() => {
  pageContentMockActive = false;
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("renderV3InjectionEntry", () => {
  test("a page selected without a matched section injects its lead with the [current: …] line under the header", async () => {
    expect(await renderV3InjectionEntry("page-a", undefined)).toBe(
      "# memory/concepts/page-a.md\n[current: Waiting on the vendor reply]\n# Page A\nlead prose",
    );
  });

  test("a page without current: renders header and head only", async () => {
    expect(await renderV3InjectionEntry("page-b", undefined)).toBe(
      "# memory/concepts/page-b.md\n# Page B\nlead b",
    );
  });

  test("a matched heading section never carries the annotation", async () => {
    expect(
      await renderV3InjectionEntry("page-a", {
        article: "page-a",
        title: "Notes",
        text: `${sectionHeadLine("page-a", "Notes")}\nnote body`,
        ordinal: 1,
      }),
    ).toBe("# memory/concepts/page-a.md § Notes\nnote body");
  });

  test("a matched lead section carries it, byte-identical to the unmatched fallback", async () => {
    expect(
      await renderV3InjectionEntry(
        "page-a",
        leadSectionOfBody("page-a", PAGE_A_BODY),
      ),
    ).toBe(await renderV3InjectionEntry("page-a", undefined));
  });

  test("a missing page renders nothing; a matched lead of a missing page renders without the annotation", async () => {
    expect(await renderV3InjectionEntry("missing", undefined)).toBe("");
    expect(
      await renderV3InjectionEntry(
        "missing",
        leadSectionOfBody("missing", "# M\nlead"),
      ),
    ).toBe("# memory/concepts/missing.md\n# M\nlead");
  });
});

describe("renderV3SectionInjection", () => {
  test("a lead with only a current: annotation still renders; an empty lead without one renders ''", () => {
    const empty = leadSectionOfBody("page-c", "");
    expect(
      renderV3SectionInjection(
        "page-c",
        empty,
        parsePageContent("page-c", "---\ncurrent: shipping Friday\n---\n")
          .frontmatter,
      ),
    ).toBe("# memory/concepts/page-c.md\n[current: shipping Friday]");
    expect(
      renderV3SectionInjection(
        "page-c",
        empty,
        parsePageContent("page-c", "").frontmatter,
      ),
    ).toBe("");
    expect(renderV3SectionInjection("page-c", empty)).toBe("");
  });
});
