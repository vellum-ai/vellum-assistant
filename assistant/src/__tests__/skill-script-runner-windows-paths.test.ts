import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { runSkillToolScript } from "../tools/skills/skill-script-runner.js";
import type { ToolContext } from "../tools/types.js";

// Regression tests for platform-specific path handling in the skill directory
// escape check (skill-script-runner.ts / sandbox-runner.ts).
//
// On win32, path.resolve() returns backslash-separated paths. A containment
// check that appends "/" to the resolved skill directory rejects every
// legitimate script path with nested segments (e.g. "tools/tool.ts"), which
// made all bundled skill tool scripts fail on Windows. These tests exercise
// nested executor paths: they pass on POSIX trivially and catch the win32
// defect. See skill-script-runner.test.ts for general behavior.

const testDir = mkdtempSync(join(tmpdir(), "skill-runner-win-test-"));

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

const ctx: ToolContext = {
  workingDir: "/tmp",
  conversationId: "test-conversation",
  trustClass: "guardian",
};

function makeSkillDir(name: string): string {
  const dir = join(testDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("skill script path check (platform separators)", () => {
  test("allows a script in a subdirectory of the skill directory (host)", async () => {
    const skillDir = makeSkillDir("subdir-skill");
    mkdirSync(join(skillDir, "tools"), { recursive: true });
    writeFileSync(
      join(skillDir, "tools", "tool.ts"),
      `export async function run() {
  return { content: 'subdir ok', isError: false };
}`,
    );

    const result = await runSkillToolScript(skillDir, "tools/tool.ts", {}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toBe("subdir ok");
  });

  test("still denies a traversal escape (host)", async () => {
    const skillDir = makeSkillDir("escape-guard");

    const result = await runSkillToolScript(
      skillDir,
      "../../../etc/passwd",
      {},
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("escapes the skill directory");
  });

  test("does not reject an in-skill path as an escape (sandbox)", async () => {
    const skillDir = makeSkillDir("sandbox-subdir");
    // The executor file is intentionally missing: the run stops at spawn/load
    // instead of executing, and the assertion is only that the path check
    // itself did not reject an in-skill path as an escape.
    const result = await runSkillToolScript(
      skillDir,
      "missing-tool.ts",
      {},
      ctx,
      { target: "sandbox" },
    );

    expect(result.content).not.toContain("escapes the skill directory");
  }, 30_000);

  test("still denies a traversal escape (sandbox)", async () => {
    const skillDir = makeSkillDir("sandbox-escape-guard");

    const result = await runSkillToolScript(
      skillDir,
      "../../../etc/passwd",
      {},
      ctx,
      { target: "sandbox" },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("escapes the skill directory");
  });
});
