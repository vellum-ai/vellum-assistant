import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getPkbAutoInjectList,
  readAutoinjectList,
} from "../daemon/conversation-runtime-assembly.js";

const PKB_DEFAULT_FILES = [
  "INDEX.md",
  "essentials.md",
  "threads.md",
  "buffer.md",
];

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let pkbDir: string;
const dirs: string[] = [];

beforeEach(() => {
  pkbDir = join(
    tmpdir(),
    `vellum-pkb-autoinject-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(pkbDir, { recursive: true });
  dirs.push(pkbDir);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("readAutoinjectList", () => {
  test("returns null when _autoinject.md does not exist", () => {
    expect(readAutoinjectList(pkbDir)).toBeNull();
  });

  test("returns empty array when _autoinject.md is empty", () => {
    writeFileSync(join(pkbDir, "_autoinject.md"), "", "utf-8");
    expect(readAutoinjectList(pkbDir)).toEqual([]);
  });

  test("returns empty array when _autoinject.md contains only comments", () => {
    writeFileSync(
      join(pkbDir, "_autoinject.md"),
      "_ This is a comment\n_ Another comment\n",
      "utf-8",
    );
    expect(readAutoinjectList(pkbDir)).toEqual([]);
  });

  test("parses standard default content", () => {
    writeFileSync(
      join(pkbDir, "_autoinject.md"),
      "_ comment\n\nINDEX.md\nessentials.md\nthreads.md\nbuffer.md\n",
      "utf-8",
    );
    expect(readAutoinjectList(pkbDir)).toEqual([
      "INDEX.md",
      "essentials.md",
      "threads.md",
      "buffer.md",
    ]);
  });

  test("parses custom entries", () => {
    writeFileSync(
      join(pkbDir, "_autoinject.md"),
      "INDEX.md\ncustom-topic.md\n",
      "utf-8",
    );
    expect(readAutoinjectList(pkbDir)).toEqual(["INDEX.md", "custom-topic.md"]);
  });

  test("strips blank lines and whitespace", () => {
    writeFileSync(
      join(pkbDir, "_autoinject.md"),
      "INDEX.md\n\n  essentials.md  \n\n",
      "utf-8",
    );
    expect(readAutoinjectList(pkbDir)).toEqual(["INDEX.md", "essentials.md"]);
  });

  test("strips comment lines mixed with filenames", () => {
    writeFileSync(
      join(pkbDir, "_autoinject.md"),
      "_ Always loaded files\nINDEX.md\n_ Core facts\nessentials.md\n",
      "utf-8",
    );
    expect(readAutoinjectList(pkbDir)).toEqual(["INDEX.md", "essentials.md"]);
  });
});

describe("getPkbAutoInjectList", () => {
  test("returns PKB_DEFAULT_FILES when _autoinject.md is missing", () => {
    // No _autoinject.md in the fresh pkbDir.
    expect(getPkbAutoInjectList(pkbDir)).toEqual(PKB_DEFAULT_FILES);
  });

  test("returns parsed list when _autoinject.md is present", () => {
    writeFileSync(
      join(pkbDir, "_autoinject.md"),
      "INDEX.md\ncustom-topic.md\n",
      "utf-8",
    );
    expect(getPkbAutoInjectList(pkbDir)).toEqual([
      "INDEX.md",
      "custom-topic.md",
    ]);
  });

  test("returns empty list (explicit opt-out) when _autoinject.md is empty", () => {
    // Empty file is an explicit "inject nothing" signal — do NOT fall back
    // to defaults.
    writeFileSync(join(pkbDir, "_autoinject.md"), "", "utf-8");
    expect(getPkbAutoInjectList(pkbDir)).toEqual([]);
  });
});
