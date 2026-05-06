/**
 * Tests for workspace migration `069-seed-onboarding-threads`.
 *
 * The migration writes onboarding bullet content to `memory/threads.md` only
 * when the file exists and is empty (or whitespace-only). It must preserve
 * any existing content and must be idempotent.
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

import { memoryV2InitMigration } from "../workspace/migrations/060-memory-v2-init.js";
import { seedOnboardingThreadsMigration } from "../workspace/migrations/069-seed-onboarding-threads.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-069-test-"));
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function readThreads(): string {
  return readFileSync(join(workspaceDir, "memory", "threads.md"), "utf-8");
}

describe("069-seed-onboarding-threads migration", () => {
  test("has correct id and description", () => {
    expect(seedOnboardingThreadsMigration.id).toBe(
      "069-seed-onboarding-threads",
    );
    expect(seedOnboardingThreadsMigration.description).toContain("threads.md");
  });

  test.each([
    ["empty file", ""],
    ["whitespace-only file", "   \n\n"],
  ])("seeds onboarding bullets when memory/threads.md is %s", (_, initial) => {
    mkdirSync(join(workspaceDir, "memory"), { recursive: true });
    writeFileSync(join(workspaceDir, "memory", "threads.md"), initial, "utf-8");

    seedOnboardingThreadsMigration.run(workspaceDir);

    const content = readThreads();
    expect(content).toContain("Figure out what kind of personality");
    expect(content).toContain("data/avatar/avatar-image.png");
    expect(content).toContain("ChatGPT, Claude");
    expect(content).toContain("Slack or Telegram");
  });

  test("preserves existing content when memory/threads.md is non-empty", () => {
    mkdirSync(join(workspaceDir, "memory"), { recursive: true });
    const existing = "Follow up with Bob about the design review.\n";
    writeFileSync(
      join(workspaceDir, "memory", "threads.md"),
      existing,
      "utf-8",
    );

    seedOnboardingThreadsMigration.run(workspaceDir);

    expect(readThreads()).toBe(existing);
  });

  test("no-op when memory/threads.md does not exist", () => {
    seedOnboardingThreadsMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "memory", "threads.md"))).toBe(false);
  });

  test("idempotent — second run does not duplicate or rewrite content", () => {
    mkdirSync(join(workspaceDir, "memory"), { recursive: true });
    writeFileSync(join(workspaceDir, "memory", "threads.md"), "", "utf-8");

    seedOnboardingThreadsMigration.run(workspaceDir);
    const afterFirst = readThreads();

    seedOnboardingThreadsMigration.run(workspaceDir);
    const afterSecond = readThreads();

    expect(afterSecond).toBe(afterFirst);
  });

  test("composes with 060: fresh workspace -> 060 -> 069 produces seeded threads.md", () => {
    memoryV2InitMigration.run(workspaceDir);
    seedOnboardingThreadsMigration.run(workspaceDir);

    expect(readThreads()).toContain("Figure out what kind of personality");
    // The other v2 prose files are untouched (still empty).
    for (const filename of ["essentials.md", "recent.md", "buffer.md"]) {
      expect(
        readFileSync(join(workspaceDir, "memory", filename), "utf-8"),
      ).toBe("");
    }
  });

  test("down() is a no-op — seeded content remains", () => {
    mkdirSync(join(workspaceDir, "memory"), { recursive: true });
    writeFileSync(join(workspaceDir, "memory", "threads.md"), "", "utf-8");

    seedOnboardingThreadsMigration.run(workspaceDir);
    const seeded = readThreads();

    seedOnboardingThreadsMigration.down(workspaceDir);

    expect(readThreads()).toBe(seeded);
  });
});
