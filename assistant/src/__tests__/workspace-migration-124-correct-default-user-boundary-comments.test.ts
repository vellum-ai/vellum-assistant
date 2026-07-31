/**
 * Tests for workspace migration `124-correct-default-user-boundary-comments`.
 *
 * The non-guardian privacy boundary renders from the always-on bundled section
 * `10a-non-guardian-boundary`, not from `users/default.md`. The greetings-only
 * seed that migration 122 wrote still had comments pointing at a "privacy
 * boundary below" as if it lived in this file. This migration rewrites exactly
 * that seed (or an absent/blank file) to a version whose comments describe the
 * boundary as built-in, and leaves any customized file untouched.
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
import { correctDefaultUserBoundaryCommentsMigration } from "../workspace/migrations/124-correct-default-user-boundary-comments.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-124-test-"));
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

/** The shipped bundled template a fresh install seeds via ensurePromptFiles(). */
function bundledTemplate(): string {
  return readFileSync(
    join(
      import.meta.dirname!,
      "..",
      "prompts",
      "templates",
      "users",
      "default.md",
    ),
    "utf-8",
  );
}

describe("124-correct-default-user-boundary-comments migration", () => {
  test("has correct id and description", () => {
    expect(correctDefaultUserBoundaryCommentsMigration.id).toBe(
      "124-correct-default-user-boundary-comments",
    );
    expect(correctDefaultUserBoundaryCommentsMigration.description).toContain(
      "default.md",
    );
  });

  test("rewrites the migration-122 greetings seed to corrected comments (the real upgrade path)", () => {
    // Reproduce the exact on-disk state the 121 → 122 chain leaves behind.
    seedDefaultUserGuardrailsMigration.run(workspaceDir);
    relocateDefaultUserBoundaryMigration.run(workspaceDir);
    const beforeCorrection = readDefault();
    expect(beforeCorrection).toContain("respecting the privacy boundary below");
    expect(beforeCorrection).toContain("within the privacy boundary below");
    expect(beforeCorrection).toContain("built in and always renders");

    correctDefaultUserBoundaryCommentsMigration.run(workspaceDir);

    const content = readDefault();
    // Stale directional references are gone...
    expect(content).not.toContain("privacy boundary below");
    expect(content).not.toContain("built in and always renders");
    expect(content).not.toContain("editing this file cannot");
    // ...replaced by the built-in phrasing.
    expect(content).toContain("respecting the built-in privacy boundary");
    expect(content).toContain("within the built-in privacy boundary");
    expect(content).toContain("so it isn't part of this file");
    // Greetings are preserved and it stays boundary-free (the boundary is
    // bundled in `10a-non-guardian-boundary`, not this file).
    expect(content).toContain("{{#isTrustedContact}}");
    expect(content).toContain("{{#isStranger}}");
    expect(content).not.toContain("Protect your guardian's privacy");
  });

  test("produces content byte-identical to the shipped bundled template", () => {
    // Fresh installs seed default.md from the bundled template; upgrades run
    // this migration. Both paths must converge on the same bytes.
    seedDefaultUserGuardrailsMigration.run(workspaceDir);
    relocateDefaultUserBoundaryMigration.run(workspaceDir);
    correctDefaultUserBoundaryCommentsMigration.run(workspaceDir);

    expect(readDefault()).toBe(bundledTemplate());
  });

  test("seeds the corrected template when the file is absent", () => {
    expect(existsSync(defaultPath())).toBe(false);

    correctDefaultUserBoundaryCommentsMigration.run(workspaceDir);

    const content = readDefault();
    expect(content).toContain("{{#isTrustedContact}}");
    expect(content).toContain("so it isn't part of this file");
    expect(content).not.toContain("privacy boundary below");
  });

  test("seeds the corrected template over a blank file", () => {
    mkdirSync(join(workspaceDir, "users"), { recursive: true });
    writeFileSync(defaultPath(), "  \n\t\n", "utf-8");

    correctDefaultUserBoundaryCommentsMigration.run(workspaceDir);

    expect(readDefault()).toContain("within the built-in privacy boundary");
  });

  test("does not clobber a customized default.md", () => {
    const existing =
      "# My contacts\n\nBe extra chatty with everyone, and mention the privacy boundary below.\n";
    mkdirSync(join(workspaceDir, "users"), { recursive: true });
    writeFileSync(defaultPath(), existing, "utf-8");

    correctDefaultUserBoundaryCommentsMigration.run(workspaceDir);

    expect(readDefault()).toBe(existing);
  });

  test("leaves an already-corrected file untouched (fresh-install no-op)", () => {
    // A fresh install already carries the corrected bundled template; the
    // migration must recognize it as non-matching and leave it alone.
    mkdirSync(join(workspaceDir, "users"), { recursive: true });
    writeFileSync(defaultPath(), bundledTemplate(), "utf-8");

    correctDefaultUserBoundaryCommentsMigration.run(workspaceDir);

    expect(readDefault()).toBe(bundledTemplate());
  });

  test("idempotent — second run does not rewrite the corrected file", () => {
    seedDefaultUserGuardrailsMigration.run(workspaceDir);
    relocateDefaultUserBoundaryMigration.run(workspaceDir);
    correctDefaultUserBoundaryCommentsMigration.run(workspaceDir);
    const afterFirst = readDefault();

    correctDefaultUserBoundaryCommentsMigration.run(workspaceDir);

    expect(readDefault()).toBe(afterFirst);
  });

  test("down() is a no-op — file remains", () => {
    correctDefaultUserBoundaryCommentsMigration.run(workspaceDir);
    const seeded = readDefault();

    correctDefaultUserBoundaryCommentsMigration.down(workspaceDir);

    expect(existsSync(defaultPath())).toBe(true);
    expect(readDefault()).toBe(seeded);
  });
});
