import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { removeWorkspaceHooksMigration } from "../workspace/migrations/048-remove-workspace-hooks.js";

let workspaceDir: string;
let hooksDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-048-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("048-remove-workspace-hooks migration (retained no-op)", () => {
  test("has correct migration id", () => {
    expect(removeWorkspaceHooksMigration.id).toBe("048-remove-workspace-hooks");
  });

  test("preserves a populated hooks directory now that it is a supported surface", () => {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, "user-prompt-submit.ts"),
      "export default () => {};",
    );

    removeWorkspaceHooksMigration.run(workspaceDir);

    expect(existsSync(hooksDir)).toBe(true);
    expect(existsSync(join(hooksDir, "user-prompt-submit.ts"))).toBe(true);
  });

  test("no-op when the hooks directory does not exist", () => {
    expect(existsSync(hooksDir)).toBe(false);

    removeWorkspaceHooksMigration.run(workspaceDir);

    expect(existsSync(hooksDir)).toBe(false);
    // The workspace itself must remain intact.
    expect(existsSync(workspaceDir)).toBe(true);
  });

  test("idempotent — safe to re-run", () => {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "stop.ts"), "export default () => {};");

    removeWorkspaceHooksMigration.run(workspaceDir);
    removeWorkspaceHooksMigration.run(workspaceDir);

    expect(existsSync(join(hooksDir, "stop.ts"))).toBe(true);
  });

  describe("down()", () => {
    test("is a no-op", () => {
      mkdirSync(hooksDir, { recursive: true });
      removeWorkspaceHooksMigration.down(workspaceDir);
      expect(existsSync(hooksDir)).toBe(true);
    });
  });
});
