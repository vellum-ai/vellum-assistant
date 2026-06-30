/**
 * Tests for workspace migration `118-seed-now-md`.
 *
 * The migration writes a stub `NOW.md` to the workspace root only when the file
 * is absent (create-only — never clobber an existing NOW.md). Unlike the
 * onboarding-threads seed (069) it is NOT gated on `isNewWorkspace`: existing
 * workspaces are exactly the ones missing the file, so the stub is seeded on
 * upgrade too. The stub is comment-only, so `stripCommentLines` reduces it to
 * empty and nothing is injected into context — the file's existence is the
 * point, so `file_edit`/read against NOW.md stop failing with "file not found".
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { stripCommentLines } from "../util/strip-comment-lines.js";
import { seedNowMdMigration } from "../workspace/migrations/118-seed-now-md.js";
import type { MigrationRunContext } from "../workspace/migrations/types.js";

const NEW_WORKSPACE_CTX: MigrationRunContext = { isNewWorkspace: true };
const UPGRADE_CTX: MigrationRunContext = { isNewWorkspace: false };

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-118-test-"));
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function nowPath(): string {
  return join(workspaceDir, "NOW.md");
}

function readNow(): string {
  return readFileSync(nowPath(), "utf-8");
}

describe("118-seed-now-md migration", () => {
  test("has correct id and description", () => {
    expect(seedNowMdMigration.id).toBe("118-seed-now-md");
    expect(seedNowMdMigration.description).toContain("NOW.md");
  });

  test("creates NOW.md when absent", () => {
    expect(existsSync(nowPath())).toBe(false);

    seedNowMdMigration.run(workspaceDir);

    expect(existsSync(nowPath())).toBe(true);
    expect(readNow().length).toBeGreaterThan(0);
  });

  test("seeds on upgrade too — not gated on isNewWorkspace", () => {
    // Existing workspaces are the ones missing the file, so an upgrade context
    // (and a brand-new one) both seed it.
    seedNowMdMigration.run(workspaceDir, UPGRADE_CTX);
    expect(existsSync(nowPath())).toBe(true);

    rmSync(nowPath());
    seedNowMdMigration.run(workspaceDir, NEW_WORKSPACE_CTX);
    expect(existsSync(nowPath())).toBe(true);
  });

  test("seeded stub strips to empty — injects nothing", () => {
    seedNowMdMigration.run(workspaceDir);
    // Every line is a `_` comment, so the scratchpad reader (which runs the
    // same strip) sees no content and the now-md injector emits nothing.
    expect(stripCommentLines(readNow())).toBe("");
  });

  test("does not clobber an existing NOW.md with real content", () => {
    const existing = "Current focus: shipping the seed migration.\n";
    writeFileSync(nowPath(), existing, "utf-8");

    seedNowMdMigration.run(workspaceDir);

    expect(readNow()).toBe(existing);
  });

  test("does not clobber an existing empty NOW.md", () => {
    writeFileSync(nowPath(), "", "utf-8");

    seedNowMdMigration.run(workspaceDir);

    expect(readNow()).toBe("");
  });

  test("idempotent — second run does not rewrite the stub", () => {
    seedNowMdMigration.run(workspaceDir);
    const afterFirst = readNow();

    seedNowMdMigration.run(workspaceDir);
    const afterSecond = readNow();

    expect(afterSecond).toBe(afterFirst);
  });

  test("down() is a no-op — seeded file remains", () => {
    seedNowMdMigration.run(workspaceDir);
    const seeded = readNow();

    seedNowMdMigration.down(workspaceDir);

    expect(existsSync(nowPath())).toBe(true);
    expect(readNow()).toBe(seeded);
  });
});
