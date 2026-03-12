import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ─── Test isolation: redirect trust store writes to a temp dir ────────────────

const testDir = mkdtempSync(join(tmpdir(), "git-hooks-trust-test-"));

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
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

import { clearCache } from "../permissions/trust-store.js";
import {
  detectConfiguredHooks,
  getGitHooksTrustDecision,
  GIT_HOOKS_TRUST_PSEUDO_TOOL,
  type GitServiceLike,
  setGitHooksTrustDecision,
} from "../workspace/git-hooks-trust.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const trustPath = join(testDir, "protected", "trust.json");

/** Make a fake GitServiceLike that returns a canned core.hooksPath value. */
function makeGitService(hooksPath?: string): GitServiceLike {
  return {
    async runReadOnlyGit(args: string[]) {
      if (args[0] === "rev-parse" && args[1] === "--git-path") {
        // Simulate git not being in a worktree context — triggers the fallback
        // to workspaceDir/.git/hooks in detectConfiguredHooks.
        throw new Error("not a git repository");
      }
      if (
        args.length >= 3 &&
        args[0] === "config" &&
        args[2] === "core.hooksPath"
      ) {
        if (hooksPath == null) {
          // Simulate "not set" — git exits non-zero
          throw new Error("git config: not found");
        }
        return { stdout: hooksPath + "\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  };
}

/** Write an executable hook file to the given directory. */
function writeHook(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return path;
}

// ─── Trust decision tri-state lookup ─────────────────────────────────────────

describe("getGitHooksTrustDecision / setGitHooksTrustDecision", () => {
  beforeEach(() => {
    clearCache();
    try {
      rmSync(trustPath);
    } catch {
      /* may not exist */
    }
  });

  afterEach(() => {
    clearCache();
  });

  test("returns 'ask' when no decision has been persisted", () => {
    const decision = getGitHooksTrustDecision("/some/workspace");
    expect(decision).toBe("ask");
  });

  test("returns 'allow' after setGitHooksTrustDecision('allow')", () => {
    const ws = "/projects/my-workspace";
    setGitHooksTrustDecision(ws, "allow");
    clearCache(); // simulate restart (forces re-read from disk)
    expect(getGitHooksTrustDecision(ws)).toBe("allow");
  });

  test("returns 'deny' after setGitHooksTrustDecision('deny')", () => {
    const ws = "/projects/my-workspace";
    setGitHooksTrustDecision(ws, "deny");
    clearCache();
    expect(getGitHooksTrustDecision(ws)).toBe("deny");
  });

  test("updating from allow to deny replaces the rule (idempotent write)", () => {
    const ws = "/projects/workspace-flip";
    setGitHooksTrustDecision(ws, "allow");
    setGitHooksTrustDecision(ws, "deny");
    clearCache();
    expect(getGitHooksTrustDecision(ws)).toBe("deny");
  });

  test("writing the same decision twice does not create duplicate rules", () => {
    const ws = "/projects/workspace-dup";
    setGitHooksTrustDecision(ws, "allow");
    setGitHooksTrustDecision(ws, "allow");
    clearCache();
    expect(getGitHooksTrustDecision(ws)).toBe("allow");
  });

  test("clearing the decision (undefined) reverts to 'ask'", () => {
    const ws = "/projects/workspace-clear";
    setGitHooksTrustDecision(ws, "allow");
    setGitHooksTrustDecision(ws, undefined);
    clearCache();
    expect(getGitHooksTrustDecision(ws)).toBe("ask");
  });

  test("decisions are scoped per workspace — different workspaces are independent", () => {
    const wsA = "/projects/workspace-a";
    const wsB = "/projects/workspace-b";
    setGitHooksTrustDecision(wsA, "allow");
    setGitHooksTrustDecision(wsB, "deny");
    clearCache();
    expect(getGitHooksTrustDecision(wsA)).toBe("allow");
    expect(getGitHooksTrustDecision(wsB)).toBe("deny");
  });

  test("trust decision survives a cache clear (persisted to disk)", () => {
    const ws = "/projects/persisted-workspace";
    setGitHooksTrustDecision(ws, "allow");
    // Simulate process restart: wipe in-memory cache so next read loads from disk
    clearCache();
    const after = getGitHooksTrustDecision(ws);
    expect(after).toBe("allow");
  });

  test("pseudo-tool key is the expected reserved constant", () => {
    expect(GIT_HOOKS_TRUST_PSEUDO_TOOL).toBe("__internal:git-hooks-trust");
  });
});

// ─── Hook detection ───────────────────────────────────────────────────────────

describe("detectConfiguredHooks", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "vellum-hook-detect-"));
  });

  afterEach(() => {
    if (existsSync(workspaceDir)) {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("returns hasHooks=false when .git/hooks has only .sample stubs", async () => {
    const hooksDir = join(workspaceDir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "pre-commit.sample"), "#!/bin/sh\n");
    writeFileSync(join(hooksDir, "pre-push.sample"), "#!/bin/sh\n");

    const result = await detectConfiguredHooks(
      workspaceDir,
      makeGitService(undefined),
    );

    expect(result.hasHooks).toBe(false);
    expect(result.hookFiles).toHaveLength(0);
    expect(result.hooksDir).toBe(join(workspaceDir, ".git", "hooks"));
  });

  test("returns hasHooks=true when an explicit hook file exists in .git/hooks", async () => {
    const hooksDir = join(workspaceDir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = writeHook(hooksDir, "pre-commit");

    const result = await detectConfiguredHooks(
      workspaceDir,
      makeGitService(undefined),
    );

    expect(result.hasHooks).toBe(true);
    expect(result.hookFiles).toContain(hookPath);
  });

  test("detects hooks in a custom core.hooksPath (relative)", async () => {
    const customDir = join(workspaceDir, ".githooks");
    mkdirSync(customDir, { recursive: true });
    const hookPath = writeHook(customDir, "commit-msg");

    const result = await detectConfiguredHooks(
      workspaceDir,
      makeGitService(".githooks"),
    );

    expect(result.hasHooks).toBe(true);
    expect(result.hookFiles).toContain(hookPath);
    expect(result.hooksDir).toBe(customDir);
  });

  test("detects hooks in a custom core.hooksPath (absolute)", async () => {
    const customDir = join(workspaceDir, "custom-hooks");
    mkdirSync(customDir, { recursive: true });
    const hookPath = writeHook(customDir, "pre-push");

    const result = await detectConfiguredHooks(
      workspaceDir,
      makeGitService(customDir),
    );

    expect(result.hasHooks).toBe(true);
    expect(result.hookFiles).toContain(hookPath);
    expect(result.hooksDir).toBe(customDir);
  });

  test("falls back to .git/hooks when core.hooksPath is not configured", async () => {
    const defaultHooksDir = join(workspaceDir, ".git", "hooks");
    mkdirSync(defaultHooksDir, { recursive: true });
    writeHook(defaultHooksDir, "post-commit");

    const result = await detectConfiguredHooks(
      workspaceDir,
      makeGitService(undefined),
    );

    expect(result.hooksDir).toBe(defaultHooksDir);
    expect(result.hasHooks).toBe(true);
  });

  test("returns hasHooks=false when hooks directory does not exist", async () => {
    // Don't create .git/hooks at all
    const result = await detectConfiguredHooks(
      workspaceDir,
      makeGitService(undefined),
    );

    expect(result.hasHooks).toBe(false);
    expect(result.hookFiles).toHaveLength(0);
  });

  test("ignores non-standard filenames in the hooks directory", async () => {
    const hooksDir = join(workspaceDir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    // Non-standard name — should be ignored
    writeFileSync(join(hooksDir, "my-custom-hook"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    // Standard stub (.sample) — should also be ignored
    writeFileSync(join(hooksDir, "pre-commit.sample"), "#!/bin/sh\n");

    const result = await detectConfiguredHooks(
      workspaceDir,
      makeGitService(undefined),
    );

    expect(result.hasHooks).toBe(false);
  });

  test("multiple hooks are all returned in hookFiles", async () => {
    const hooksDir = join(workspaceDir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const p1 = writeHook(hooksDir, "pre-commit");
    const p2 = writeHook(hooksDir, "pre-push");
    const p3 = writeHook(hooksDir, "commit-msg");

    const result = await detectConfiguredHooks(
      workspaceDir,
      makeGitService(undefined),
    );

    expect(result.hasHooks).toBe(true);
    expect(result.hookFiles).toContain(p1);
    expect(result.hookFiles).toContain(p2);
    expect(result.hookFiles).toContain(p3);
  });
});
