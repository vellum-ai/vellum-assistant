/**
 * Tests for reading an install layout: telling a repo checkout from an
 * installed package, and locating the `assistant` command that ships with an
 * install.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { findAssistantCommand, isRepoCheckoutPath } from "../index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "install-layout-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Create `<nodeModulesDir>/.bin/assistant` and return its path. */
function seedCommand(nodeModulesDir: string): string {
  const binDir = join(nodeModulesDir, ".bin");
  mkdirSync(binDir, { recursive: true });
  const command = join(binDir, "assistant");
  writeFileSync(command, "#!/usr/bin/env bun\n");
  return command;
}

describe("isRepoCheckoutPath", () => {
  test("an installed package is not a checkout", () => {
    expect(
      isRepoCheckoutPath(
        "/Users/x/Library/Application Support/@vellumai/macos/cli/latest/node_modules/@vellumai/assistant/src/index.ts",
      ),
    ).toBe(false);
  });

  test("a repo checkout is", () => {
    expect(
      isRepoCheckoutPath("/Users/x/dev/vellum/assistant/src/index.ts"),
    ).toBe(true);
  });

  test("a directory merely named node_modules-ish is not enough", () => {
    expect(
      isRepoCheckoutPath("/Users/x/node_modules_backup/a/src/index.ts"),
    ).toBe(true);
  });
});

describe("findAssistantCommand", () => {
  test("finds the command shipped beside an installed package", () => {
    const nodeModules = join(root, "cli", "latest", "node_modules");
    const command = seedCommand(nodeModules);
    const path = join(nodeModules, "@vellumai", "assistant", "src", "index.ts");

    expect(findAssistantCommand(path)).toBe(command);
  });

  test("prefers a nested install over a hoisted one", () => {
    const outer = join(root, "node_modules");
    const outerCommand = seedCommand(outer);
    const inner = join(outer, "vellum", "node_modules");
    const innerCommand = seedCommand(inner);
    const path = join(inner, "@vellumai", "assistant", "src", "index.ts");

    expect(findAssistantCommand(path)).toBe(innerCommand);
    expect(innerCommand).not.toBe(outerCommand);
  });

  test("falls back to a hoisted install when the nested one has no command", () => {
    const outer = join(root, "node_modules");
    const outerCommand = seedCommand(outer);
    const inner = join(outer, "vellum", "node_modules");
    mkdirSync(inner, { recursive: true });
    const path = join(inner, "@vellumai", "assistant", "src", "index.ts");

    expect(findAssistantCommand(path)).toBe(outerCommand);
  });

  test("returns null for a repo checkout", () => {
    expect(
      findAssistantCommand(join(root, "assistant", "src", "index.ts")),
    ).toBeNull();
  });

  test("returns null when the install ships no assistant command", () => {
    const nodeModules = join(root, "node_modules");
    mkdirSync(join(nodeModules, ".bin"), { recursive: true });
    const path = join(nodeModules, "@vellumai", "assistant", "src", "index.ts");

    expect(findAssistantCommand(path)).toBeNull();
  });
});
