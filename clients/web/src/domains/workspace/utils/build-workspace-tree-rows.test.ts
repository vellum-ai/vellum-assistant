import { describe, expect, test } from "bun:test";

import {
  buildWorkspaceTreeRows,
  listedDirectoryPaths,
  type WorkspaceTreeEntry,
} from "./build-workspace-tree-rows";

function dir(path: string, size: number | null = null): WorkspaceTreeEntry {
  return {
    name: path.split("/").pop() ?? path,
    path,
    type: "directory",
    size,
    mimeType: null,
    modifiedAt: "2026-01-01T00:00:00.000Z",
  };
}

function file(path: string, size = 1): WorkspaceTreeEntry {
  return {
    name: path.split("/").pop() ?? path,
    path,
    type: "file",
    size,
    mimeType: "text/markdown",
    modifiedAt: "2026-01-01T00:00:00.000Z",
  };
}

const LISTINGS = new Map<string, WorkspaceTreeEntry[]>([
  ["", [dir("docs"), dir("notes"), file("readme.md")]],
  ["docs", [dir("docs/guides"), file("docs/theme.md"), file("docs/other.md")]],
  ["docs/guides", [file("docs/guides/theme-deep.md")]],
  ["notes", [file("notes/theme-hidden-behind-closed-folder.md")]],
]);

function paths(rows: ReturnType<typeof buildWorkspaceTreeRows>) {
  return rows.map((row) => row.entry.path);
}

describe("listedDirectoryPaths", () => {
  test("lists only the root when nothing is open", () => {
    expect(listedDirectoryPaths(new Set(), false)).toEqual([""]);
  });

  test("lists an open folder whose ancestors are all open", () => {
    expect(
      listedDirectoryPaths(new Set(["docs", "docs/guides"]), false),
    ).toEqual(["", "docs", "docs/guides"]);
  });

  test("does not list an open folder under a closed one", () => {
    expect(listedDirectoryPaths(new Set(["docs/guides"]), false)).toEqual([""]);
  });

  test("lists an open hidden folder only while hidden entries are shown", () => {
    const expanded = new Set([".config", ".config/nested", "docs"]);
    expect(listedDirectoryPaths(expanded, false)).toEqual(["", "docs"]);
    expect(listedDirectoryPaths(expanded, true)).toEqual([
      "",
      ".config",
      ".config/nested",
      "docs",
    ]);
  });
});

describe("buildWorkspaceTreeRows without a query", () => {
  test("a closed folder contributes only its own row", () => {
    const rows = buildWorkspaceTreeRows({
      listings: LISTINGS,
      expandedPaths: new Set(),
      sortMode: "name",
      query: "",
    });
    expect(paths(rows)).toEqual(["docs", "notes", "readme.md"]);
    expect(rows.every((row) => row.depth === 0)).toBe(true);
  });

  test("an open folder is followed by its children one level deeper", () => {
    const rows = buildWorkspaceTreeRows({
      listings: LISTINGS,
      expandedPaths: new Set(["docs"]),
      sortMode: "name",
      query: "",
    });
    expect(paths(rows)).toEqual([
      "docs",
      "docs/guides",
      "docs/theme.md",
      "docs/other.md",
      "notes",
      "readme.md",
    ]);
    expect(rows.find((row) => row.entry.path === "docs/theme.md")?.depth).toBe(
      1,
    );
    expect(rows.find((row) => row.entry.path === "docs")?.isExpanded).toBe(
      true,
    );
  });

  test("an open folder whose listing has not loaded shows as open with no children", () => {
    const rows = buildWorkspaceTreeRows({
      listings: new Map([["", [dir("pending")]]]),
      expandedPaths: new Set(["pending"]),
      sortMode: "name",
      query: "",
    });
    expect(rows).toEqual([
      { entry: dir("pending"), depth: 0, isExpanded: true },
    ]);
  });

  test("size mode orders each level by size", () => {
    const rows = buildWorkspaceTreeRows({
      listings: new Map([["", [file("small.md", 1), file("large.md", 99)]]]),
      expandedPaths: new Set(),
      sortMode: "size",
      query: "",
    });
    expect(paths(rows)).toEqual(["large.md", "small.md"]);
  });
});

describe("buildWorkspaceTreeRows with a query", () => {
  test("shows matching files in open folders with the folders that hold them", () => {
    const rows = buildWorkspaceTreeRows({
      listings: LISTINGS,
      expandedPaths: new Set(["docs", "docs/guides"]),
      sortMode: "name",
      query: "theme",
    });
    expect(paths(rows)).toEqual([
      "docs",
      "docs/guides",
      "docs/guides/theme-deep.md",
      "docs/theme.md",
    ]);
  });

  test("a folder with no match inside it and no matching name is hidden", () => {
    const rows = buildWorkspaceTreeRows({
      listings: LISTINGS,
      expandedPaths: new Set(["docs", "notes"]),
      sortMode: "name",
      query: "other",
    });
    expect(paths(rows)).toEqual(["docs", "docs/other.md"]);
  });

  test("a closed folder is not looked inside, even when its listing is cached", () => {
    const rows = buildWorkspaceTreeRows({
      listings: LISTINGS,
      expandedPaths: new Set(),
      sortMode: "name",
      query: "theme",
    });
    expect(rows).toEqual([]);
  });

  test("a folder whose own name matches appears without matching children", () => {
    const rows = buildWorkspaceTreeRows({
      listings: LISTINGS,
      expandedPaths: new Set(["docs"]),
      sortMode: "name",
      query: "guides",
    });
    expect(paths(rows)).toEqual(["docs", "docs/guides"]);
  });

  test("matching ignores case and surrounding whitespace", () => {
    const rows = buildWorkspaceTreeRows({
      listings: LISTINGS,
      expandedPaths: new Set(),
      sortMode: "name",
      query: "  README ",
    });
    expect(paths(rows)).toEqual(["readme.md"]);
  });
});
