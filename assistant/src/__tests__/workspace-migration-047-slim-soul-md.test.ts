import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { slimSoulMdMigration } from "../workspace/migrations/047-slim-soul-md.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-047-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
}

function soulPath(): string {
  return join(workspaceDir, "SOUL.md");
}

const LEGACY_TEMPLATE_FIXTURE = readFileSync(
  join(import.meta.dirname, "fixtures", "047-legacy-soul-template.md.fixture"),
  "utf-8",
);

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("047-slim-soul-md migration", () => {
  test("has correct migration id", () => {
    expect(slimSoulMdMigration.id).toBe("047-slim-soul-md");
  });

  test("no-op when SOUL.md does not exist", () => {
    expect(existsSync(soulPath())).toBe(false);
    slimSoulMdMigration.run(workspaceDir);
    expect(existsSync(soulPath())).toBe(false);
  });

  test("replaces verbatim legacy SOUL.md with the slim template", () => {
    writeFileSync(soulPath(), LEGACY_TEMPLATE_FIXTURE);
    slimSoulMdMigration.run(workspaceDir);

    const after = readFileSync(soulPath(), "utf-8");
    expect(after).not.toBe(LEGACY_TEMPLATE_FIXTURE);
    expect(after).toContain("A soul can travel");
    // Relocated sections must no longer live in workspace SOUL.md.
    expect(after).not.toContain("## Safety");
    expect(after).not.toContain("## Compliance");
    expect(after).not.toContain("## Boundaries");
    expect(after).not.toContain("## Journal");
    expect(after).not.toContain("## Scratchpad");
    expect(after).not.toContain("## Knowledge Base");
    expect(after).not.toContain("Talk before you work");
  });

  test("leaves customized SOUL.md untouched", () => {
    const customized =
      LEGACY_TEMPLATE_FIXTURE + "\n## My Custom Section\n\nMy added text.\n";
    writeFileSync(soulPath(), customized);

    slimSoulMdMigration.run(workspaceDir);

    const after = readFileSync(soulPath(), "utf-8");
    expect(after).toBe(customized);
  });

  test("leaves a SOUL.md that only shares the old title alone", () => {
    const almost = "# SOUL.md\n\nWholly different content.\n";
    writeFileSync(soulPath(), almost);

    slimSoulMdMigration.run(workspaceDir);

    expect(readFileSync(soulPath(), "utf-8")).toBe(almost);
  });

  test("is idempotent on a file already slimmed by a prior run", () => {
    writeFileSync(soulPath(), LEGACY_TEMPLATE_FIXTURE);
    slimSoulMdMigration.run(workspaceDir);
    const afterFirst = readFileSync(soulPath(), "utf-8");

    slimSoulMdMigration.run(workspaceDir);
    const afterSecond = readFileSync(soulPath(), "utf-8");

    expect(afterSecond).toBe(afterFirst);
  });

  test("treats a legacy file with CRLF line endings as matching", () => {
    writeFileSync(soulPath(), LEGACY_TEMPLATE_FIXTURE.replace(/\n/g, "\r\n"));
    slimSoulMdMigration.run(workspaceDir);

    const after = readFileSync(soulPath(), "utf-8");
    expect(after).toContain("A soul can travel");
  });
});
