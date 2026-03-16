import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { runSkillToolScript } from "../tools/skills/skill-script-runner.js";
import type { ToolContext } from "../tools/types.js";

const testDir = mkdtempSync(join(tmpdir(), "skill-runner-test-"));

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

// ── Host execution ──────────────────────────────────────────────────

describe("runSkillToolScript (host)", () => {
  test("runs a valid skill script and returns result", async () => {
    const skillDir = makeSkillDir("valid-skill");
    writeFileSync(
      join(skillDir, "tool.ts"),
      `
      export async function run(input, context) {
        return { content: 'Hello from skill! Input: ' + JSON.stringify(input), isError: false };
      }
    `,
    );

    const result = await runSkillToolScript(
      skillDir,
      "tool.ts",
      { foo: "bar" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Hello from skill!");
    expect(result.content).toContain('"foo":"bar"');
  });

  test("blocks path traversal escape", async () => {
    const skillDir = makeSkillDir("escape-skill");

    const result = await runSkillToolScript(
      skillDir,
      "../../../etc/passwd",
      {},
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("escapes the skill directory");
  });

  test("returns error when script does not export run()", async () => {
    const skillDir = makeSkillDir("no-run-skill");
    writeFileSync(
      join(skillDir, "bad.ts"),
      `
      export const name = 'not a runner';
    `,
    );

    const result = await runSkillToolScript(skillDir, "bad.ts", {}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('does not export a "run" function');
  });

  test("returns error when script throws", async () => {
    const skillDir = makeSkillDir("throw-skill");
    writeFileSync(
      join(skillDir, "throw.ts"),
      `
      export async function run() {
        throw new Error('Intentional test error');
      }
    `,
    );

    const result = await runSkillToolScript(skillDir, "throw.ts", {}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Intentional test error");
  });

  test("returns error when script file does not exist", async () => {
    const skillDir = makeSkillDir("missing-skill");

    const result = await runSkillToolScript(
      skillDir,
      "nonexistent.ts",
      {},
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Failed to load skill tool script");
  });
});

// ── Version hash checking ───────────────────────────────────────────

describe("runSkillToolScript version hash", () => {
  test("blocks execution when hash mismatches", async () => {
    const skillDir = makeSkillDir("hash-mismatch");
    writeFileSync(
      join(skillDir, "tool.ts"),
      `
      export async function run() {
        return { content: 'should not run', isError: false };
      }
    `,
    );

    const result = await runSkillToolScript(skillDir, "tool.ts", {}, ctx, {
      expectedSkillVersionHash: "expected-hash-123",
      skillDirHashResolver: () => "different-hash-456",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Skill version mismatch");
    expect(result.content).toContain("expected-hash-123");
    expect(result.content).toContain("different-hash-456");
  });

  test("allows execution when hash matches", async () => {
    const skillDir = makeSkillDir("hash-match");
    writeFileSync(
      join(skillDir, "tool.ts"),
      `
      export async function run() {
        return { content: 'hash matched', isError: false };
      }
    `,
    );

    const result = await runSkillToolScript(skillDir, "tool.ts", {}, ctx, {
      expectedSkillVersionHash: "matching-hash",
      skillDirHashResolver: () => "matching-hash",
    });

    expect(result.isError).toBe(false);
    expect(result.content).toBe("hash matched");
  });

  test("returns error when hash resolver throws", async () => {
    const skillDir = makeSkillDir("hash-error");
    writeFileSync(
      join(skillDir, "tool.ts"),
      `
      export async function run() {
        return { content: 'should not run', isError: false };
      }
    `,
    );

    const result = await runSkillToolScript(skillDir, "tool.ts", {}, ctx, {
      expectedSkillVersionHash: "some-hash",
      skillDirHashResolver: () => {
        throw new Error("hash computation failed");
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Failed to compute skill version hash");
    expect(result.content).toContain("hash computation failed");
  });

  test("skips hash check when no expected hash provided", async () => {
    const skillDir = makeSkillDir("no-hash");
    writeFileSync(
      join(skillDir, "tool.ts"),
      `
      export async function run() {
        return { content: 'no hash check', isError: false };
      }
    `,
    );

    const result = await runSkillToolScript(skillDir, "tool.ts", {}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toBe("no hash check");
  });
});
