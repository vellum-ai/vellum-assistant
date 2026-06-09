import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { loadCoreSet } from "./core-set.js";

let workspaceDir: string;

function writeCorePages(content: string): void {
  mkdirSync(join(workspaceDir, "memory"), { recursive: true });
  writeFileSync(join(workspaceDir, "memory", "core-pages.md"), content);
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "core-set-test-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("loadCoreSet", () => {
  test("missing file yields []", () => {
    expect(loadCoreSet(workspaceDir)).toEqual([]);
  });

  test("accepts both wikilink and bare-slug list forms", () => {
    writeCorePages(["- [[page-a]]", "- page-b"].join("\n"));
    expect(loadCoreSet(workspaceDir)).toEqual(["page-a", "page-b"]);
  });

  test("accepts inline annotations after the slug", () => {
    writeCorePages(
      [
        "- [[page-a]] — register frame, never matches lexically",
        "- [[page-b]] keep while the project is live",
        "- page-c — calibration rules",
        "- page-d – en-dash annotation",
        "- page-e - hyphen annotation",
      ].join("\n"),
    );
    expect(loadCoreSet(workspaceDir)).toEqual([
      "page-a",
      "page-b",
      "page-c",
      "page-d",
      "page-e",
    ]);
  });

  test("ignores headings, blank lines, and prose annotations", () => {
    writeCorePages(
      [
        "# Core pages",
        "",
        "Curated during consolidation; keep this list short.",
        "- [[page-a]]",
        "",
        "## Identity frames",
        "These never match lexically but should always be candidates.",
        "- page-b",
      ].join("\n"),
    );
    expect(loadCoreSet(workspaceDir)).toEqual(["page-a", "page-b"]);
  });

  test("dedupes while preserving first-seen order", () => {
    writeCorePages(
      ["- page-b", "- [[page-a]]", "- [[page-b]]", "- page-a", "- page-c"].join(
        "\n",
      ),
    );
    expect(loadCoreSet(workspaceDir)).toEqual(["page-b", "page-a", "page-c"]);
  });

  test("skips entries outside the slug-safe charset", () => {
    writeCorePages(
      [
        "- [[Page A]]",
        "- page_b",
        "- [[topics/page-a]]",
        "- UPPER-CASE",
        "- page-b",
        "- [[]]",
      ].join("\n"),
    );
    expect(loadCoreSet(workspaceDir)).toEqual(["topics/page-a", "page-b"]);
  });

  test("malformed list lines are skipped, not fatal", () => {
    writeCorePages(
      [
        "-",
        "-no-space",
        "- [[unclosed",
        "- two words here",
        "- prose that mentions — a dash mid-sentence",
        "- page-a",
      ].join("\n"),
    );
    expect(loadCoreSet(workspaceDir)).toEqual(["page-a"]);
  });
});
