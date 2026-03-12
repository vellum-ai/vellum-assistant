import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  getAllRules,
  removePseudoRule,
  upsertPseudoRule,
} from "../permissions/trust-store.js";

/**
 * Pseudo-tool key used to persist git hook trust decisions in the trust store.
 * Prefixed with "__internal:" to avoid collision with real tool names and to
 * signal that these rules are not user-visible permission rules.
 */
export const GIT_HOOKS_TRUST_PSEUDO_TOOL = "__internal:git-hooks-trust";

/**
 * Pattern suffix that encodes the workspace directory in a trust rule pattern
 * so that one workspace's decision does not bleed into another.
 */
function patternForWorkspace(workspaceDir: string): string {
  return workspaceDir;
}

/**
 * Retrieve the persisted git hooks trust decision for a workspace.
 *
 * Returns:
 * - `"allow"` — user has explicitly trusted this workspace's hooks.
 * - `"deny"`  — user has explicitly denied hook execution for this workspace.
 * - `"ask"`   — no persisted decision; the user should be prompted.
 */
export function getGitHooksTrustDecision(
  workspaceDir: string,
): "allow" | "deny" | "ask" {
  const pattern = patternForWorkspace(workspaceDir);
  const rules = getAllRules();
  for (const rule of rules) {
    if (
      rule.tool === GIT_HOOKS_TRUST_PSEUDO_TOOL &&
      rule.pattern === pattern &&
      (rule.decision === "allow" || rule.decision === "deny")
    ) {
      return rule.decision;
    }
  }
  return "ask";
}

/**
 * Persist a git hooks trust decision for a workspace.
 *
 * Idempotent: replaces any existing pseudo-rule for this workspace so there
 * are never two conflicting entries.
 *
 * @param workspaceDir - Absolute path to the workspace directory.
 * @param decision     - `"allow"` to trust hooks, `"deny"` to block them.
 *                       Pass `undefined` to clear a previously stored decision.
 */
export function setGitHooksTrustDecision(
  workspaceDir: string,
  decision: "allow" | "deny" | undefined,
): void {
  const pattern = patternForWorkspace(workspaceDir);
  if (decision === undefined) {
    removePseudoRule(GIT_HOOKS_TRUST_PSEUDO_TOOL, pattern);
    return;
  }
  upsertPseudoRule(
    GIT_HOOKS_TRUST_PSEUDO_TOOL,
    pattern,
    workspaceDir,
    decision,
  );
}

// ─── Hook detection ──────────────────────────────────────────────────────────

/**
 * Minimal interface for the git service dependency used during hook detection.
 * Accepting an interface rather than the concrete class keeps this module
 * testable without spawning a real git subprocess.
 */
export interface GitServiceLike {
  runReadOnlyGit(args: string[]): Promise<{ stdout: string; stderr: string }>;
}

/**
 * The canonical set of standard git hook names.
 * Only hooks in this list are considered "active" during detection — we
 * intentionally ignore the `.sample` stubs that `git init` writes by default.
 */
const STANDARD_HOOK_NAMES = new Set([
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "post-receive",
  "post-update",
  "push-to-checkout",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "fsmonitor-watchman",
  "p4-changelist",
  "p4-prepare-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
  "post-index-change",
]);

export interface DetectedHooks {
  /** Absolute paths to active (non-sample) hook files found. */
  hookFiles: string[];
  /** The resolved hooks directory path (either `.git/hooks` or `core.hooksPath`). */
  hooksDir: string;
  /** Whether any executable hook files were found (i.e. hooks are configured). */
  hasHooks: boolean;
}

/**
 * Detect whether a workspace has git hooks configured.
 *
 * Checks both the default `.git/hooks` directory and any `core.hooksPath`
 * configured in the repo's git config.  Only files whose names match the
 * canonical hook-name list are counted — this conservatively ignores the
 * `.sample` stubs that `git init` installs by default.
 *
 * @param workspaceDir  - Absolute path to the workspace directory.
 * @param gitService    - A `GitServiceLike` object whose `runReadOnlyGit` is
 *                        used to read git config.  Pass the real
 *                        `WorkspaceGitService` in production and a test double
 *                        in unit tests.
 */
export async function detectConfiguredHooks(
  workspaceDir: string,
  gitService: GitServiceLike,
): Promise<DetectedHooks> {
  // 1. Resolve the effective hooks directory.
  let hooksDir = join(workspaceDir, ".git", "hooks");
  try {
    const { stdout } = await gitService.runReadOnlyGit([
      "config",
      "--local",
      "core.hooksPath",
    ]);
    const customPath = stdout.trim();
    if (customPath) {
      // Resolve relative paths against the workspace directory.
      hooksDir = customPath.startsWith("/")
        ? customPath
        : join(workspaceDir, customPath);
    }
  } catch {
    // core.hooksPath not set — fall back to the default .git/hooks directory.
  }

  // 2. Scan the hooks directory for active (non-sample) hook files.
  const hookFiles: string[] = [];

  if (existsSync(hooksDir)) {
    const { readdirSync, statSync } = await import("node:fs");
    let entries: string[] = [];
    try {
      entries = readdirSync(hooksDir);
    } catch {
      // Directory exists but is not readable — treat as no hooks.
    }

    for (const entry of entries) {
      if (!STANDARD_HOOK_NAMES.has(entry)) continue;
      const fullPath = join(hooksDir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile()) {
          hookFiles.push(fullPath);
        }
      } catch {
        // File disappeared between readdir and stat — ignore.
      }
    }
  }

  return {
    hookFiles,
    hooksDir,
    hasHooks: hookFiles.length > 0,
  };
}
