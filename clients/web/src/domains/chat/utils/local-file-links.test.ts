import { describe, expect, test } from "bun:test";

import {
  classifyMarkdownHref,
  toWorkspacePathFromHref,
} from "@/domains/chat/utils/local-file-links";

describe("toWorkspacePathFromHref: accepted shapes", () => {
  test("absolute path under the hosted /workspace mount", () => {
    expect(toWorkspacePathFromHref("/workspace/scratch/a.png")).toBe(
      "scratch/a.png",
    );
  });

  test("absolute path under a desktop instance mount", () => {
    expect(
      toWorkspacePathFromHref(
        "/Users/alice/.vellum/instances/x/workspace/a.png",
      ),
    ).toBe("a.png");
  });

  test("percent-encoded spaces and unicode decode", () => {
    expect(
      toWorkspacePathFromHref("/workspace/My%20Report%20%F0%9F%93%8A.pdf"),
    ).toBe("My Report 📊.pdf");
  });

  test("author intent allows characters a code span would reject", () => {
    expect(toWorkspacePathFromHref("/workspace/notes (final).md")).toBe(
      "notes (final).md",
    );
    expect(toWorkspacePathFromHref("/workspace/rapport détaillé.pdf")).toBe(
      "rapport détaillé.pdf",
    );
  });

  test("relative paths are workspace-relative as written", () => {
    expect(toWorkspacePathFromHref("scratch/a.png")).toBe("scratch/a.png");
    expect(toWorkspacePathFromHref("./scratch/a.png")).toBe("scratch/a.png");
    // Unlike a code span, a bare filename in a link destination is unambiguous.
    expect(toWorkspacePathFromHref("a.png")).toBe("a.png");
  });
});

describe("toWorkspacePathFromHref: fragments and queries", () => {
  test("a fragment names a place inside the file, not part of its path", () => {
    expect(toWorkspacePathFromHref("docs/guide.md#intro")).toBe(
      "docs/guide.md",
    );
    expect(toWorkspacePathFromHref("/workspace/docs/guide.md#intro")).toBe(
      "docs/guide.md",
    );
  });

  test("a query string is dropped the same way", () => {
    expect(toWorkspacePathFromHref("docs/guide.md?v=2")).toBe("docs/guide.md");
    expect(toWorkspacePathFromHref("docs/guide.md?v=2#intro")).toBe(
      "docs/guide.md",
    );
    // A `?` after the `#` belongs to the fragment.
    expect(toWorkspacePathFromHref("docs/guide.md#a?b")).toBe("docs/guide.md");
  });

  test("an encoded # or ? stays part of the filename", () => {
    expect(toWorkspacePathFromHref("docs/issue%2342.md")).toBe(
      "docs/issue#42.md",
    );
    expect(toWorkspacePathFromHref("docs/what%3F.md")).toBe("docs/what?.md");
  });

  test("classification carries the stripped path and filename", () => {
    expect(classifyMarkdownHref("docs/guide.md#intro")).toEqual({
      kind: "local-file",
      workspacePath: "docs/guide.md",
      filename: "guide.md",
    });
    expect(classifyMarkdownHref("/Users/alice/Desktop/a.png#top")).toEqual({
      kind: "local-file",
      workspacePath: null,
      filename: "a.png",
    });
  });
});

describe("toWorkspacePathFromHref: rejected shapes", () => {
  test("absolute path outside any workspace mount", () => {
    expect(toWorkspacePathFromHref("/etc/passwd")).toBeNull();
    expect(toWorkspacePathFromHref("/Users/alice/Desktop/a.png")).toBeNull();
  });

  test("traversal segments, encoded or not", () => {
    expect(toWorkspacePathFromHref("/workspace/../etc/passwd")).toBeNull();
    expect(toWorkspacePathFromHref("/workspace/%2e%2e/etc/passwd")).toBeNull();
    expect(toWorkspacePathFromHref("scratch/../../etc/passwd")).toBeNull();
    expect(toWorkspacePathFromHref("/workspace/./a.png")).toBeNull();
  });

  test("hidden segments", () => {
    expect(
      toWorkspacePathFromHref("/workspace/.claude/settings.json"),
    ).toBeNull();
    expect(toWorkspacePathFromHref("scratch/.env")).toBeNull();
  });

  test("directory shapes and empty segments", () => {
    expect(toWorkspacePathFromHref("/workspace/scratch/")).toBeNull();
    expect(toWorkspacePathFromHref("/workspace/scratch//a.png")).toBeNull();
    expect(toWorkspacePathFromHref("")).toBeNull();
  });

  test("oversized paths", () => {
    expect(
      toWorkspacePathFromHref(`/workspace/${"a".repeat(600)}.png`),
    ).toBeNull();
  });

  test("malformed percent-encoding", () => {
    expect(toWorkspacePathFromHref("/workspace/50%.png")).toBeNull();
    expect(toWorkspacePathFromHref("/workspace/%E0%A4%A.png")).toBeNull();
  });

  test("paths that decode to a null byte", () => {
    expect(toWorkspacePathFromHref("/workspace/a%00.png")).toBeNull();
  });
});

describe("classifyMarkdownHref", () => {
  test("web URLs", () => {
    expect(classifyMarkdownHref("https://example.com/a.png")).toEqual({
      kind: "web",
    });
    expect(classifyMarkdownHref("http://example.com")).toEqual({ kind: "web" });
    // Protocol-relative URLs inherit the page scheme.
    expect(classifyMarkdownHref("//example.com/a.png")).toEqual({
      kind: "web",
    });
  });

  test("vellum attachment links", () => {
    expect(classifyMarkdownHref("vellum://workspace/scratch/a.png")).toEqual({
      kind: "vellum",
    });
    expect(classifyMarkdownHref("vellum://host/tmp/a.png")).toEqual({
      kind: "vellum",
    });
  });

  test("other schemes and anchors", () => {
    expect(classifyMarkdownHref("mailto:user@example.com")).toEqual({
      kind: "other",
    });
    expect(classifyMarkdownHref("data:text/plain,hi")).toEqual({
      kind: "other",
    });
    expect(classifyMarkdownHref("#section-2")).toEqual({ kind: "other" });
    expect(classifyMarkdownHref("")).toEqual({ kind: "other" });
    expect(classifyMarkdownHref(undefined)).toEqual({ kind: "other" });
    // No scheme, no directory component: ordinary link text, not a path.
    expect(classifyMarkdownHref("a.png")).toEqual({ kind: "other" });
  });

  test("absolute workspace paths carry the relative path and filename", () => {
    expect(classifyMarkdownHref("/workspace/scratch/a.png")).toEqual({
      kind: "local-file",
      workspacePath: "scratch/a.png",
      filename: "a.png",
    });
    expect(
      classifyMarkdownHref("/workspace/My%20Report%20%F0%9F%93%8A.pdf"),
    ).toEqual({
      kind: "local-file",
      workspacePath: "My Report 📊.pdf",
      filename: "My Report 📊.pdf",
    });
  });

  test("relative paths with a directory component", () => {
    expect(classifyMarkdownHref("scratch/a.png")).toEqual({
      kind: "local-file",
      workspacePath: "scratch/a.png",
      filename: "a.png",
    });
    expect(classifyMarkdownHref("./a.png")).toEqual({
      kind: "local-file",
      workspacePath: "a.png",
      filename: "a.png",
    });
  });

  test("a path outside the workspace is still a file reference", () => {
    expect(classifyMarkdownHref("/Users/alice/Desktop/a.png")).toEqual({
      kind: "local-file",
      workspacePath: null,
      filename: "a.png",
    });
  });

  test("traversal resolves to an unservable file reference", () => {
    expect(classifyMarkdownHref("/workspace/../etc/passwd")).toEqual({
      kind: "local-file",
      workspacePath: null,
      filename: "passwd",
    });
  });
});
