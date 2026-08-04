/**
 * Tests for classifying a resolved assistant entrypoint and finding the
 * `assistant` command that ships beside it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  assistantCommandPathDirs,
  isRepoCheckoutEntry,
} from "../assistant-command-path.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "assistant-command-path-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Create `<dir>/.bin/assistant` so the lookup finds a command there. */
function seedBin(nodeModulesDir: string): string {
  const binDir = join(nodeModulesDir, ".bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "assistant"), "#!/usr/bin/env bun\n");
  return binDir;
}

describe("isRepoCheckoutEntry", () => {
  test("an installed package is not a checkout", () => {
    expect(
      isRepoCheckoutEntry(
        "/Users/x/Library/Application Support/@vellumai/macos/cli/latest/node_modules/@vellumai/assistant/src/index.ts",
      ),
    ).toBe(false);
  });

  test("a repo checkout is", () => {
    expect(
      isRepoCheckoutEntry("/Users/x/dev/vellum/assistant/src/index.ts"),
    ).toBe(true);
  });

  test("a directory merely named node_modules-ish is not enough", () => {
    expect(
      isRepoCheckoutEntry("/Users/x/node_modules_backup/a/src/index.ts"),
    ).toBe(true);
  });
});

describe("assistantCommandPathDirs", () => {
  test("finds the .bin beside an installed assistant package", () => {
    const nodeModules = join(root, "cli", "latest", "node_modules");
    const binDir = seedBin(nodeModules);
    const entry = join(
      nodeModules,
      "@vellumai",
      "assistant",
      "src",
      "index.ts",
    );

    expect(assistantCommandPathDirs(entry)).toEqual([binDir]);
  });

  test("prefers a nested install over a hoisted one", () => {
    const outer = join(root, "node_modules");
    const outerBin = seedBin(outer);
    const inner = join(outer, "vellum", "node_modules");
    const innerBin = seedBin(inner);
    const entry = join(inner, "@vellumai", "assistant", "src", "index.ts");

    expect(assistantCommandPathDirs(entry)).toEqual([innerBin]);
    expect(innerBin).not.toBe(outerBin);
  });

  test("falls back to a hoisted install when the nested one has no command", () => {
    const outer = join(root, "node_modules");
    const outerBin = seedBin(outer);
    const inner = join(outer, "vellum", "node_modules");
    mkdirSync(inner, { recursive: true });
    const entry = join(inner, "@vellumai", "assistant", "src", "index.ts");

    expect(assistantCommandPathDirs(entry)).toEqual([outerBin]);
  });

  test("returns nothing for a repo checkout", () => {
    expect(
      assistantCommandPathDirs(join(root, "assistant", "src", "index.ts")),
    ).toEqual([]);
  });

  test("returns nothing when the install has no assistant command", () => {
    const nodeModules = join(root, "node_modules");
    mkdirSync(join(nodeModules, ".bin"), { recursive: true });
    const entry = join(
      nodeModules,
      "@vellumai",
      "assistant",
      "src",
      "index.ts",
    );

    expect(assistantCommandPathDirs(entry)).toEqual([]);
  });
});
