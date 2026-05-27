/**
 * Test preload verifier — runs immediately after test-preload.ts.
 *
 * Bun already exits with code 1 when a preload throws, has an unresolvable
 * import, or doesn't exist on disk (verified empirically). This file is
 * the explicit check for the remaining failure mode: the main preload
 * ran successfully but didn't actually isolate workspace state (e.g. a
 * future refactor of test-preload.ts introduces a logic bug that no-ops
 * the env override).
 *
 * Without this verifier, that failure mode would silently let tests
 * resolve `VELLUM_WORKSPACE_DIR` to the real `~/.vellum/workspace` and
 * potentially destroy live data — which is exactly the surface the May
 * 2026 DB ghost incidents exploited.
 *
 * Order matters: bunfig.toml lists this AFTER test-preload.ts so the
 * main preload's env writes are observable here.
 *
 * No source-module imports — only node stdlib (matches the same rule
 * test-preload.ts enforces).
 *
 * Escape hatch: VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS=1, mirroring the
 * existing `assertTestDbIsIsolated()` in db-connection.ts.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

function fail(reason: string): never {
  throw new Error(
    [
      `Test preload verifier failed: ${reason}.`,
      "",
      "test-preload.ts ran but did not isolate workspace state. Common",
      "causes:",
      "  - a logic bug in test-preload.ts (env override removed/reordered)",
      "  - a preload phase threw silently and the verifier still picked up",
      "    partial state",
      "",
      "See journal/2026-05-25-db-ghost-3-recovery.md for the incident",
      "history this guard prevents.",
      "",
      "If this is an integration test that intentionally wants the real",
      "workspace, set VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS=1.",
    ].join("\n"),
  );
}

if (process.env.VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS !== "1") {
  const workspaceDir = process.env.VELLUM_WORKSPACE_DIR?.trim();
  if (!workspaceDir) {
    fail("VELLUM_WORKSPACE_DIR is not set after main preload");
  }

  // Canonicalize through symlinks so /tmp/foo and /private/tmp/foo (macOS)
  // compare equal, and any path-segment variation normalizes.
  function canonicalize(p: string): string {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  }

  const resolvedWorkspace = canonicalize(workspaceDir);
  const realWorkspace = canonicalize(
    process.env.VELLUM_TEST_REAL_WORKSPACE_DIR?.trim() ||
      join(homedir(), ".vellum", "workspace"),
  );

  if (
    resolvedWorkspace === realWorkspace ||
    resolvedWorkspace.startsWith(realWorkspace + sep)
  ) {
    fail(
      `VELLUM_WORKSPACE_DIR resolves to ${resolvedWorkspace}, which is the real workspace`,
    );
  }
}
