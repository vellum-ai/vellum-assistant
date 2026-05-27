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
 * resolve `VELLUM_WORKSPACE_DIR` to the real `/workspace` and potentially
 * destroy live data.
 *
 * Order matters: bunfig.toml lists this AFTER test-preload.ts so the
 * main preload's env writes are observable here.
 *
 * No source-module imports — only node stdlib (matches the same rule
 * test-preload.ts enforces).
 *
 * Positive assertion: `VELLUM_WORKSPACE_DIR` MUST resolve under
 * `os.tmpdir()`. This mirrors exactly what test-preload.ts does
 * (`mkdtempSync(join(tmpdir(), "vellum-test-"))`), so any other value
 * indicates the preload either didn't run or didn't take effect.
 */

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";

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
    ].join("\n"),
  );
}

function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const workspaceDir = process.env.VELLUM_WORKSPACE_DIR?.trim();
if (!workspaceDir) {
  fail("VELLUM_WORKSPACE_DIR is not set after main preload");
}

const resolvedWorkspace = canonicalize(workspaceDir);
const tmpRoot = canonicalize(tmpdir());

if (
  resolvedWorkspace !== tmpRoot &&
  !resolvedWorkspace.startsWith(tmpRoot + sep)
) {
  fail(
    `VELLUM_WORKSPACE_DIR resolves to ${resolvedWorkspace}, which is not under ${tmpRoot}`,
  );
}
