import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

/**
 * Guard for skill ↔ public-docs drift. A bundled skill's SKILL.md is the
 * behavioral source of truth; its public reference page lives in a separate
 * repo (vellum-assistant-platform, https://www.vellum.ai/docs/skills-reference).
 * `scripts/check-skill-docs-sync.ts` fingerprints each documented SKILL.md so a
 * behavior change can't land without the author reconciling the docs page and
 * re-recording the fingerprint.
 *
 * This guard runs that check. On failure, the script's output names the skills
 * whose SKILL.md drifted and the docs page to update — read it, fix the docs,
 * then run `bun run scripts/check-skill-docs-sync.ts --write`.
 */
describe("skill ↔ public-docs sync", () => {
  test("documented SKILL.md files match their recorded fingerprint", () => {
    const repoRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../..",
    );
    const result = spawnSync(
      process.execPath,
      ["run", "scripts/check-skill-docs-sync.ts"],
      { cwd: repoRoot, encoding: "utf8" },
    );

    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(output, output).not.toBe("");
    expect(result.status, output).toBe(0);
  });
});
