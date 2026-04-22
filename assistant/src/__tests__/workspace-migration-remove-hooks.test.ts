import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { removeWorkspaceHooksMigration } from "../workspace/migrations/047-remove-workspace-hooks.js";

let workspaceDir: string;
let hooksDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-046-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  hooksDir = join(workspaceDir, "hooks");
  mkdirSync(workspaceDir, { recursive: true });
}

const dirs: string[] = [];

beforeEach(() => {
  freshWorkspace();
  dirs.push(workspaceDir);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("047-remove-workspace-hooks migration", () => {
  test("has correct migration id", () => {
    expect(removeWorkspaceHooksMigration.id).toBe("047-remove-workspace-hooks");
  });

  test("removes a populated hooks directory", () => {
    mkdirSync(hooksDir, { recursive: true });
    mkdirSync(join(hooksDir, "my-hook"), { recursive: true });
    writeFileSync(join(hooksDir, "my-hook", "manifest.json"), "{}");
    writeFileSync(join(hooksDir, "my-hook", "run.sh"), "#!/bin/sh\n");
    writeFileSync(join(hooksDir, "README.md"), "hooks live here");

    removeWorkspaceHooksMigration.run(workspaceDir);

    expect(existsSync(hooksDir)).toBe(false);
  });

  test("removes an empty hooks directory", () => {
    mkdirSync(hooksDir, { recursive: true });

    removeWorkspaceHooksMigration.run(workspaceDir);

    expect(existsSync(hooksDir)).toBe(false);
  });

  test("no-op when the hooks directory does not exist", () => {
    expect(existsSync(hooksDir)).toBe(false);

    removeWorkspaceHooksMigration.run(workspaceDir);

    expect(existsSync(hooksDir)).toBe(false);
    // The workspace itself must remain intact.
    expect(existsSync(workspaceDir)).toBe(true);
  });

  test("idempotent — safe to re-run after the directory is gone", () => {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "stale.json"), "{}");

    removeWorkspaceHooksMigration.run(workspaceDir);
    // Second invocation is a no-op and must not throw.
    removeWorkspaceHooksMigration.run(workspaceDir);

    expect(existsSync(hooksDir)).toBe(false);
  });

  test("does not touch unrelated workspace entries", () => {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "stale.json"), "{}");
    const skillsDir = join(workspaceDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "keep.md"), "keep me");

    removeWorkspaceHooksMigration.run(workspaceDir);

    expect(existsSync(hooksDir)).toBe(false);
    expect(existsSync(skillsDir)).toBe(true);
    expect(existsSync(join(skillsDir, "keep.md"))).toBe(true);
  });

  describe("down()", () => {
    test("is a no-op", () => {
      removeWorkspaceHooksMigration.down(workspaceDir);
      expect(existsSync(hooksDir)).toBe(false);
    });
  });
});
