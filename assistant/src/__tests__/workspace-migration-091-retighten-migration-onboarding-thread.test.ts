/**
 * Tests for workspace migration `091-retighten-migration-onboarding-thread`.
 *
 * The migration rewrites the assistant-migration onboarding bullet in
 * `memory/threads.md` (seeded by 069) only for newly-created workspaces
 * (`ctx.isNewWorkspace === true`) when the exact old bullet is present. It is a
 * no-op on upgrade, when the old bullet is absent, and when the file is
 * missing. It must be idempotent and compose with 069 (069 seeds the old
 * bullets, then 091 retightens bullet 3).
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

import { seedOnboardingThreadsMigration } from "../workspace/migrations/069-seed-onboarding-threads.js";
import { retightenMigrationOnboardingThreadMigration } from "../workspace/migrations/091-retighten-migration-onboarding-thread.js";
import type { MigrationRunContext } from "../workspace/migrations/types.js";

const NEW_WORKSPACE_CTX: MigrationRunContext = { isNewWorkspace: true };
const UPGRADE_CTX: MigrationRunContext = { isNewWorkspace: false };

// Literal copy of the 4-bullet block 069 seeds into memory/threads.md. The
// third bullet is the one 091 retightens.
const ONBOARDING_THREADS = `- Figure out what kind of personality would best mesh with your user. Figure out who you are and what your voice should be. Your choice should be DISTINCT and have CHARACTER. Once you've figured this out, rewrite SOUL.md and IDENTITY.md in your own voice to define who you are.
- Work with your user to set a custom avatar for yourself. This task is done once data/avatar/avatar-image.png exists.
- Ask your user if they use ChatGPT, Claude or another AI tool and offer to help them import memories from there.
- Suggest connecting to available messaging services like Slack or Telegram
`;

const OLD_BULLET =
  "- Ask your user if they use ChatGPT, Claude or another AI tool and offer to help them import memories from there.";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-091-test-"));
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function seedThreads(content: string): void {
  mkdirSync(join(workspaceDir, "memory"), { recursive: true });
  writeFileSync(join(workspaceDir, "memory", "threads.md"), content, "utf-8");
}

function readThreads(): string {
  return readFileSync(join(workspaceDir, "memory", "threads.md"), "utf-8");
}

describe("091-retighten-migration-onboarding-thread migration", () => {
  test("has correct id and description", () => {
    expect(retightenMigrationOnboardingThreadMigration.id).toBe(
      "091-retighten-migration-onboarding-thread",
    );
    expect(retightenMigrationOnboardingThreadMigration.description).toContain(
      "threads.md",
    );
  });

  test("replaces the old bullet on a new workspace, preserving the others", () => {
    seedThreads(ONBOARDING_THREADS);

    retightenMigrationOnboardingThreadMigration.run(
      workspaceDir,
      NEW_WORKSPACE_CTX,
    );

    const content = readThreads();
    expect(content).not.toContain(OLD_BULLET);
    expect(content).toContain("first real task");
    expect(content).toContain("ChatGPT, Claude");
    // The other three onboarding bullets are preserved verbatim.
    expect(content).toContain("Figure out what kind of personality");
    expect(content).toContain("data/avatar/avatar-image.png");
    expect(content).toContain("Slack or Telegram");
  });

  test("no-op on upgrade even when the old bullet is present", () => {
    seedThreads(ONBOARDING_THREADS);

    retightenMigrationOnboardingThreadMigration.run(workspaceDir, UPGRADE_CTX);

    expect(readThreads()).toBe(ONBOARDING_THREADS);
  });

  test("no-op when the old bullet is absent (user-edited content)", () => {
    const edited = "- A bullet the user wrote themselves.\n";
    seedThreads(edited);

    retightenMigrationOnboardingThreadMigration.run(
      workspaceDir,
      NEW_WORKSPACE_CTX,
    );

    expect(readThreads()).toBe(edited);
  });

  test("no-op when memory/threads.md does not exist", () => {
    retightenMigrationOnboardingThreadMigration.run(
      workspaceDir,
      NEW_WORKSPACE_CTX,
    );
    expect(existsSync(join(workspaceDir, "memory", "threads.md"))).toBe(false);
  });

  test("idempotent — second run produces identical content", () => {
    seedThreads(ONBOARDING_THREADS);

    retightenMigrationOnboardingThreadMigration.run(
      workspaceDir,
      NEW_WORKSPACE_CTX,
    );
    const afterFirst = readThreads();

    retightenMigrationOnboardingThreadMigration.run(
      workspaceDir,
      NEW_WORKSPACE_CTX,
    );
    const afterSecond = readThreads();

    expect(afterSecond).toBe(afterFirst);
  });

  test("composes 069 -> 091: fresh empty workspace ends with the new bullet", () => {
    // Mirror how the 069 test sets up: create an empty threads.md first.
    seedThreads("");

    seedOnboardingThreadsMigration.run(workspaceDir, NEW_WORKSPACE_CTX);
    retightenMigrationOnboardingThreadMigration.run(
      workspaceDir,
      NEW_WORKSPACE_CTX,
    );

    const content = readThreads();
    expect(content).not.toContain(OLD_BULLET);
    expect(content).toContain("first real task");
    expect(content).toContain("ChatGPT, Claude");
  });

  test("down() is a no-op — rewritten content remains", () => {
    seedThreads(ONBOARDING_THREADS);

    retightenMigrationOnboardingThreadMigration.run(
      workspaceDir,
      NEW_WORKSPACE_CTX,
    );
    const rewritten = readThreads();

    retightenMigrationOnboardingThreadMigration.down(workspaceDir);

    expect(readThreads()).toBe(rewritten);
  });
});
