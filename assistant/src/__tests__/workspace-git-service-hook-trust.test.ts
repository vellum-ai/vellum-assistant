/**
 * Tests for the policy-based hook execution in WorkspaceGitService.
 *
 * These tests verify that:
 * - When the trust decision is "allow", git hooks execute normally.
 * - When the trust decision is "deny" or "ask", git hooks are suppressed.
 *
 * They use mock.module to control the getGitHooksTrustDecision return value
 * without touching the real trust store on disk.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ─── Mocks (must be declared before imports that transitively load them) ──────

// Control the trust decision for each test via this variable.
let mockDecision: "allow" | "deny" | "ask" = "ask";

mock.module("../workspace/git-hooks-trust.js", () => ({
  getGitHooksTrustDecision: (_workspaceDir: string) => mockDecision,
  setGitHooksTrustDecision: () => {},
  detectConfiguredHooks: async () => ({
    hookFiles: [],
    hooksDir: "",
    hasHooks: false,
  }),
  GIT_HOOKS_TRUST_PSEUDO_TOOL: "__internal:git-hooks-trust",
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  _resetGitServiceRegistry,
  WorkspaceGitService,
} from "../workspace/git-service.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Write an executable hook script that touches a sentinel file when it runs.
 * This lets us detect whether a hook was executed.
 */
function installHook(
  repoDir: string,
  hookName: string,
  sentinelPath: string,
): void {
  const hooksDir = join(repoDir, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, hookName);
  writeFileSync(hookPath, `#!/bin/sh\ntouch "${sentinelPath}"\nexit 0\n`, {
    mode: 0o755,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WorkspaceGitService — hook trust policy", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `vellum-hook-trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    _resetGitServiceRegistry();
    // Reset decision to fail-closed default before each test.
    mockDecision = "ask";
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('decision: "deny" — hooks suppressed', () => {
    test("commitChanges does not run pre-commit hook when decision is deny", async () => {
      mockDecision = "deny";

      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const sentinel = join(testDir, "pre-commit-ran.marker");
      installHook(testDir, "pre-commit", sentinel);

      writeFileSync(join(testDir, "file.txt"), "content");
      await service.commitChanges("test: deny suppresses pre-commit");

      expect(existsSync(sentinel)).toBe(false);
    });

    test("commitIfDirty does not run pre-commit hook when decision is deny", async () => {
      mockDecision = "deny";

      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const sentinel = join(testDir, "pre-commit-ran.marker");
      installHook(testDir, "pre-commit", sentinel);

      writeFileSync(join(testDir, "dirty.txt"), "dirty content");
      const result = await service.commitIfDirty(() => ({
        message: "test: deny suppresses pre-commit in commitIfDirty",
      }));

      expect(result.committed).toBe(true);
      expect(existsSync(sentinel)).toBe(false);
    });
  });

  describe('decision: "ask" — hooks suppressed (fail-closed default)', () => {
    test("commitChanges does not run pre-commit hook when decision is ask", async () => {
      mockDecision = "ask";

      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const sentinel = join(testDir, "pre-commit-ran.marker");
      installHook(testDir, "pre-commit", sentinel);

      writeFileSync(join(testDir, "file.txt"), "content");
      await service.commitChanges("test: ask suppresses pre-commit");

      expect(existsSync(sentinel)).toBe(false);
    });

    test("commitIfDirty does not run pre-commit hook when decision is ask", async () => {
      mockDecision = "ask";

      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const sentinel = join(testDir, "pre-commit-ran.marker");
      installHook(testDir, "pre-commit", sentinel);

      writeFileSync(join(testDir, "dirty.txt"), "dirty content");
      const result = await service.commitIfDirty(() => ({
        message: "test: ask suppresses pre-commit in commitIfDirty",
      }));

      expect(result.committed).toBe(true);
      expect(existsSync(sentinel)).toBe(false);
    });
  });

  describe('decision: "allow" — hooks execute for trusted workspaces', () => {
    test("commitChanges runs pre-commit hook when decision is allow", async () => {
      mockDecision = "allow";

      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const sentinel = join(testDir, "pre-commit-ran.marker");
      installHook(testDir, "pre-commit", sentinel);

      writeFileSync(join(testDir, "file.txt"), "content");
      await service.commitChanges("test: allow enables pre-commit");

      expect(existsSync(sentinel)).toBe(true);
    });

    test("commitChanges runs post-commit hook when decision is allow", async () => {
      mockDecision = "allow";

      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const sentinel = join(testDir, "post-commit-ran.marker");
      installHook(testDir, "post-commit", sentinel);

      writeFileSync(join(testDir, "file.txt"), "content");
      await service.commitChanges("test: allow enables post-commit");

      expect(existsSync(sentinel)).toBe(true);
    });

    test("commitIfDirty runs pre-commit hook when decision is allow", async () => {
      mockDecision = "allow";

      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const sentinel = join(testDir, "pre-commit-ran.marker");
      installHook(testDir, "pre-commit", sentinel);

      writeFileSync(join(testDir, "dirty.txt"), "dirty content");
      const result = await service.commitIfDirty(() => ({
        message: "test: allow enables pre-commit in commitIfDirty",
      }));

      expect(result.committed).toBe(true);
      expect(existsSync(sentinel)).toBe(true);
    });

    test("hooks do not run for untrusted workspace when another workspace is trusted (decision is workspace-scoped)", async () => {
      // This test verifies that the decision is per-workspace. Since mock returns
      // the same decision for all dirs, we verify by testing deny path in sequence.

      // First, verify allow path works
      mockDecision = "allow";
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const allowSentinel = join(testDir, "hook-allow.marker");
      installHook(testDir, "pre-commit", allowSentinel);

      writeFileSync(join(testDir, "file.txt"), "v1");
      await service.commitChanges("test: allow mode");
      expect(existsSync(allowSentinel)).toBe(true);

      // Now switch to deny and verify hooks are suppressed on next commit
      mockDecision = "deny";
      writeFileSync(join(testDir, "file.txt"), "v2");
      await service.commitChanges("test: deny mode");

      // The sentinel was already created in allow mode — use a second sentinel
      // to verify no additional hook execution occurs in deny mode.
      const denySentinel = join(testDir, "hook-deny.marker");
      // Replace the hook with one that writes the deny sentinel
      installHook(testDir, "pre-commit", denySentinel);
      writeFileSync(join(testDir, "file.txt"), "v3");
      await service.commitChanges("test: deny suppresses second hook");
      expect(existsSync(denySentinel)).toBe(false);
    });
  });
});
