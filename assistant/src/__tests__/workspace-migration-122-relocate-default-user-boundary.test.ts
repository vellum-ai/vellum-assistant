/**
 * Tests for workspace migration `122-relocate-default-user-boundary`.
 *
 * The non-guardian privacy boundary moved from `users/default.md` into the
 * always-on bundled section `10a-non-guardian-boundary`, so installs still
 * carrying the migration-121 seed would render the boundary twice. The
 * migration rewrites exactly that seed (or an absent/blank file) to the
 * greetings-only template and leaves any customized file untouched.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { seedDefaultUserGuardrailsMigration } from "../workspace/migrations/121-seed-default-user-guardrails.js";
import { relocateDefaultUserBoundaryMigration } from "../workspace/migrations/122-relocate-default-user-boundary.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-122-test-"));
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function defaultPath(): string {
  return join(workspaceDir, "users", "default.md");
}

function readDefault(): string {
  return readFileSync(defaultPath(), "utf-8");
}

describe("122-relocate-default-user-boundary migration", () => {
  test("has correct id and description", () => {
    expect(relocateDefaultUserBoundaryMigration.id).toBe(
      "122-relocate-default-user-boundary",
    );
    expect(relocateDefaultUserBoundaryMigration.description).toContain(
      "default.md",
    );
  });

  test("rewrites the migration-121 seed to greetings-only (the real upgrade path)", () => {
    // Produce the exact on-disk state migration 121 left behind, then upgrade.
    seedDefaultUserGuardrailsMigration.run(workspaceDir);
    expect(readDefault()).toContain("Protect your guardian's privacy");

    relocateDefaultUserBoundaryMigration.run(workspaceDir);

    const content = readDefault();
    expect(content).not.toContain("Protect your guardian's privacy");
    expect(content).not.toContain("{{^isGuardian}}");
    expect(content).toContain("{{#isTrustedContact}}");
    expect(content).toContain("{{#isStranger}}");
  });

  test("seeds the greetings-only template when the file is absent", () => {
    expect(existsSync(defaultPath())).toBe(false);

    relocateDefaultUserBoundaryMigration.run(workspaceDir);

    const content = readDefault();
    expect(content).toContain("{{#isTrustedContact}}");
    expect(content).not.toContain("Protect your guardian's privacy");
  });

  test("seeds the greetings-only template over a blank file", () => {
    mkdirSync(join(workspaceDir, "users"), { recursive: true });
    writeFileSync(defaultPath(), "  \n\t\n", "utf-8");

    relocateDefaultUserBoundaryMigration.run(workspaceDir);

    expect(readDefault()).toContain("{{#isTrustedContact}}");
  });

  test("does not clobber a customized default.md", () => {
    const existing =
      "# My contacts\n\nBe extra chatty with everyone.\n\n## Protect your guardian's privacy\n\nMy own wording of the boundary.\n";
    mkdirSync(join(workspaceDir, "users"), { recursive: true });
    writeFileSync(defaultPath(), existing, "utf-8");

    relocateDefaultUserBoundaryMigration.run(workspaceDir);

    expect(readDefault()).toBe(existing);
  });

  test("idempotent — second run does not rewrite the greetings-only file", () => {
    seedDefaultUserGuardrailsMigration.run(workspaceDir);
    relocateDefaultUserBoundaryMigration.run(workspaceDir);
    const afterFirst = readDefault();

    relocateDefaultUserBoundaryMigration.run(workspaceDir);

    expect(readDefault()).toBe(afterFirst);
  });

  test("down() is a no-op — file remains", () => {
    relocateDefaultUserBoundaryMigration.run(workspaceDir);
    const seeded = readDefault();

    relocateDefaultUserBoundaryMigration.down(workspaceDir);

    expect(existsSync(defaultPath())).toBe(true);
    expect(readDefault()).toBe(seeded);
  });
});
