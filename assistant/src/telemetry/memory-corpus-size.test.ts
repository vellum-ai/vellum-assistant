import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workspaceDir = "";

mock.module("../util/platform.js", () => ({
  getWorkspaceDir: () => workspaceDir,
}));

import { measureMemoryCorpusSize } from "./memory-corpus-size.js";

function write(relativePath: string, contents: string): void {
  const full = join(workspaceDir, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

describe("measureMemoryCorpusSize", () => {
  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "corpus-size-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("an empty workspace measures as all zeros", () => {
    expect(measureMemoryCorpusSize()).toEqual({
      concept_pages: 0,
      concept_bytes: 0,
      pkb_files: 0,
      pkb_bytes: 0,
      buffer_lines: 0,
    });
  });

  test("counts concept pages recursively and totals their bytes", () => {
    write("memory/concepts/alice.md", "12345"); // 5 bytes
    write("memory/concepts/people/bob.md", "1234567890"); // 10 bytes
    write("memory/concepts/people/nested/carol.md", "12345"); // 5 bytes

    const size = measureMemoryCorpusSize();

    expect(size.concept_pages).toBe(3);
    expect(size.concept_bytes).toBe(20);
  });

  test("counts the PKB tree independently of concept pages", () => {
    write("memory/concepts/alice.md", "12345");
    write("pkb/essentials.md", "1234567890");
    write("pkb/archive/2026-01-01.md", "12345");

    const size = measureMemoryCorpusSize();

    expect(size.concept_pages).toBe(1);
    expect(size.pkb_files).toBe(2);
    expect(size.pkb_bytes).toBe(15);
  });

  test("ignores non-markdown files", () => {
    write("memory/concepts/alice.md", "12345");
    write("memory/concepts/notes.txt", "ignored");
    write("memory/concepts/.DS_Store", "ignored");

    expect(measureMemoryCorpusSize().concept_pages).toBe(1);
  });

  test("buffer_lines counts non-empty lines only", () => {
    write("memory/buffer.md", "- one\n\n- two\n   \n- three\n");

    expect(measureMemoryCorpusSize().buffer_lines).toBe(3);
  });

  test("an absent buffer reads as zero rather than failing", () => {
    write("memory/concepts/alice.md", "12345");

    expect(measureMemoryCorpusSize().buffer_lines).toBe(0);
  });

  test("does not follow symlinked directories", () => {
    // A link back to an ancestor would otherwise walk forever. Dirents carry
    // lstat semantics, so the link is skipped rather than recursed into.
    write("memory/concepts/alice.md", "12345");
    mkdirSync(join(workspaceDir, "outside"), { recursive: true });
    writeFileSync(join(workspaceDir, "outside", "extra.md"), "12345", "utf8");
    symlinkSync(
      join(workspaceDir, "outside"),
      join(workspaceDir, "memory", "concepts", "linked"),
      "dir",
    );

    const size = measureMemoryCorpusSize();

    expect(size.concept_pages).toBe(1);
    expect(size.concept_bytes).toBe(5);
  });
});
