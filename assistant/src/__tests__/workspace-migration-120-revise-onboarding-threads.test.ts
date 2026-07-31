/**
 * Tests for workspace migration `120-revise-onboarding-threads`.
 *
 * The migration revises the onboarding bullets in `memory/threads.md` (seeded
 * by 069, retightened by 091) only for newly-created workspaces
 * (`ctx.isNewWorkspace === true`): it drops the personality-authoring bullet and
 * retargets the avatar bullet at the vellum-avatar skill. It is a no-op on
 * upgrade, when the known bullets are absent, and when the file is missing. It
 * must be idempotent and compose with 069 and 091.
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
import { reviseOnboardingThreadsMigration } from "../workspace/migrations/120-revise-onboarding-threads.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import type { MigrationRunContext } from "../workspace/migrations/types.js";

const NEW_WORKSPACE_CTX: MigrationRunContext = { isNewWorkspace: true };
const UPGRADE_CTX: MigrationRunContext = { isNewWorkspace: false };

// Literal copy of the 4-bullet block 069 seeds into memory/threads.md. 120
// drops bullet 1 (personality) and rewrites bullet 2 (avatar); it leaves
// bullets 3 and 4 untouched.
const ONBOARDING_THREADS = `- Figure out what kind of personality would best mesh with your user. Figure out who you are and what your voice should be. Your choice should be DISTINCT and have CHARACTER. Once you've figured this out, rewrite SOUL.md and IDENTITY.md in your own voice to define who you are.
- Work with your user to set a custom avatar for yourself. This task is done once data/avatar/avatar-image.png exists.
- Ask your user if they use ChatGPT, Claude or another AI tool and offer to help them import memories from there.
- Suggest connecting to available messaging services like Slack or Telegram
`;

const PERSONALITY_SNIPPET = "Figure out what kind of personality";
const OLD_AVATAR_BULLET =
  "- Work with your user to set a custom avatar for yourself. This task is done once data/avatar/avatar-image.png exists.";
const NEW_AVATAR_SNIPPET =
  "custom AI generated avatar for yourself using the `vellum-avatar` skill";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-120-test-"));
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

describe("120-revise-onboarding-threads migration", () => {
  test("has correct id and description", () => {
    expect(reviseOnboardingThreadsMigration.id).toBe(
      "120-revise-onboarding-threads",
    );
    expect(reviseOnboardingThreadsMigration.description).toContain(
      "threads.md",
    );
  });

  test("is registered in WORKSPACE_MIGRATIONS", () => {
    expect(WORKSPACE_MIGRATIONS).toContain(reviseOnboardingThreadsMigration);
  });

  test("drops the personality bullet and retargets the avatar bullet, preserving the rest", () => {
    seedThreads(ONBOARDING_THREADS);

    reviseOnboardingThreadsMigration.run(workspaceDir, NEW_WORKSPACE_CTX);

    const content = readThreads();
    // The personality-authoring bullet is gone.
    expect(content).not.toContain(PERSONALITY_SNIPPET);
    // The avatar bullet is retargeted at the vellum-avatar skill.
    expect(content).not.toContain(OLD_AVATAR_BULLET);
    expect(content).toContain(NEW_AVATAR_SNIPPET);
    // The other two onboarding bullets are preserved verbatim.
    expect(content).toContain("ChatGPT, Claude");
    expect(content).toContain("Slack or Telegram");
    // Removing bullet 1 leaves no leading blank line — the file now begins with
    // the (revised) avatar bullet.
    expect(
      content.startsWith(
        "- Work with your user to set a custom AI generated avatar",
      ),
    ).toBe(true);
  });

  test("no-op on upgrade even when the bullets are present", () => {
    seedThreads(ONBOARDING_THREADS);

    reviseOnboardingThreadsMigration.run(workspaceDir, UPGRADE_CTX);

    expect(readThreads()).toBe(ONBOARDING_THREADS);
  });

  test("no-op when the bullets are absent (user-edited content)", () => {
    const edited = "- A bullet the user wrote themselves.\n";
    seedThreads(edited);

    reviseOnboardingThreadsMigration.run(workspaceDir, NEW_WORKSPACE_CTX);

    expect(readThreads()).toBe(edited);
  });

  test("no-op when memory/threads.md does not exist", () => {
    reviseOnboardingThreadsMigration.run(workspaceDir, NEW_WORKSPACE_CTX);
    expect(existsSync(join(workspaceDir, "memory", "threads.md"))).toBe(false);
  });

  test("idempotent — second run produces identical content", () => {
    seedThreads(ONBOARDING_THREADS);

    reviseOnboardingThreadsMigration.run(workspaceDir, NEW_WORKSPACE_CTX);
    const afterFirst = readThreads();

    reviseOnboardingThreadsMigration.run(workspaceDir, NEW_WORKSPACE_CTX);
    const afterSecond = readThreads();

    expect(afterSecond).toBe(afterFirst);
  });

  test("composes 069 -> 091 -> 120: fresh empty workspace ends with the revised bullets", () => {
    // Mirror how the 069/091 tests set up: create an empty threads.md first.
    seedThreads("");

    seedOnboardingThreadsMigration.run(workspaceDir, NEW_WORKSPACE_CTX);
    retightenMigrationOnboardingThreadMigration.run(
      workspaceDir,
      NEW_WORKSPACE_CTX,
    );
    reviseOnboardingThreadsMigration.run(workspaceDir, NEW_WORKSPACE_CTX);

    const content = readThreads();
    expect(content).not.toContain(PERSONALITY_SNIPPET);
    expect(content).toContain(NEW_AVATAR_SNIPPET);
    // 091's retightened assistant-migration bullet survives.
    expect(content).toContain("first real task");
    expect(content).toContain("ChatGPT, Claude");
    // The messaging bullet survives.
    expect(content).toContain("Slack or Telegram");
    // Exactly three bullets remain.
    expect(
      content.split("\n").filter((line) => line.startsWith("- ")).length,
    ).toBe(3);
  });

  test("down() is a no-op — revised content remains", () => {
    seedThreads(ONBOARDING_THREADS);

    reviseOnboardingThreadsMigration.run(workspaceDir, NEW_WORKSPACE_CTX);
    const revised = readThreads();

    reviseOnboardingThreadsMigration.down(workspaceDir);

    expect(readThreads()).toBe(revised);
  });
});
